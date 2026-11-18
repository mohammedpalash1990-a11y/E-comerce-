import { id, now, HttpError, text } from './postgres-shared.mjs';
import { createPostgresCheckoutRepository } from './postgres-checkout.mjs';
import { createPostgresOrderLifecycleRepository } from './postgres-orders.mjs';
import { registerPostgresInventoryRoutes } from './postgres-inventory-routes.mjs';
import { DEFAULT_STOREFRONT_CONFIG, mergeStorefrontConfig, computeDynamicShippingPaisa, loadPgStorefrontConfig } from './storefront-config.mjs';

const money = value => Number(value || 0) / 100;
const orderNumber = id => 'HAAT-' + String(id).replace(/-/g, '').slice(0, 10).toUpperCase();

async function writeEvent(database, orderId, sellerOrderId, status, note, actorId) {
  await database.q('INSERT INTO order_events(id,order_id,seller_order_id,status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id(), orderId, sellerOrderId || null, status, note || '', actorId || null, now());
}
async function writeAudit(database, actorId, action, entity, entityId, detail = {}) {
  await database.q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id(), actorId || null, action, entity, entityId || null, JSON.stringify(detail), now());
}
async function notify(database, userId, title, body = '') {
  if (!userId) return;
  await database.q('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
    .run(id(), userId, title, body, now());
}

// PostgreSQL-only commerce HTTP routes. This module is deliberately not imported
// by the legacy SQLite server; mount it only in the isolated PostgreSQL runtime.
export function registerPostgresCommerceRoutes(route, ok, options = {}) {
  const { database } = options;
  if (!database?.q || !database?.tx) throw new TypeError('PostgreSQL database is required');

  const checkout = options.checkoutRepository || createPostgresCheckoutRepository(database, {
    id, now,
    shippingFor: options.shippingFor,
    couponFor: options.couponFor,
    paymentMethods: options.paymentMethods || ['COD'],
    initiatePayment: options.initiatePayment || (options.paymentRepository
      ? input => options.paymentRepository.initiatePayment(input)
      : options.startPayment),
    orderNo: orderNumber,
    notify: (uid, title, body) => notify(database, uid, title, body),
    addEvent: (oid, soid, status, note, actor) => writeEvent(database, oid, soid, status, note, actor),
    audit: (actor, action, entity, entityId, detail) => writeAudit(database, actor, action, entity, entityId, detail)
  });
  const lifecycle = options.orderRepository || createPostgresOrderLifecycleRepository(database, {
    id, now, orderNo: orderNumber,
    notify: (uid, title, body) => notify(database, uid, title, body),
    audit: (actor, action, entity, entityId, detail) => writeAudit(database, actor, action, entity, entityId, detail)
  });

  route('GET', '/api/v1/storefront/config', null, async () => ok(await loadPgStorefrontConfig(database)));

  route('GET', '/api/v1/shipping/quote', null, async ({ url }) => {
    const sub = Math.round(Number(url.searchParams.get('subtotal_bdt') || 0) * 100);
    let fee = null;
    try {
      const rows = await database.q('SELECT key,value FROM platform_settings').all();
      if (Array.isArray(rows) && rows.length > 0) {
        fee = computeDynamicShippingPaisa(url.searchParams.get('area') || '', sub, mergeStorefrontConfig(rows));
      }
    } catch {}
    if (fee === null) {
      fee = typeof options.shippingFor === 'function'
        ? await options.shippingFor(url.searchParams.get('area') || '', sub)
        : computeDynamicShippingPaisa(url.searchParams.get('area') || '', sub, DEFAULT_STOREFRONT_CONFIG);
    }
    return ok({ shipping_bdt: money(fee) });
  });

  route('POST', '/api/v1/checkout', ['CUSTOMER'], async ({ user, body }) => {
    const result = await checkout.checkout(user, body);
    return ok({ ...result, orderNumber: result.orderNumber || orderNumber(result.id) }, 201);
  });

  route('GET', '/api/v1/customer/orders', ['CUSTOMER'], async ({ user }) => {
    const rows = await database.q('SELECT id,total_paisa,status,created_at,payment_method,payment_status FROM orders WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(user.id);
    return ok(rows.map(row => ({ id: row.id, orderNumber: orderNumber(row.id), total_bdt: money(row.total_paisa), status: row.status, payment: { method: row.payment_method, status: row.payment_status }, created_at: row.created_at })));
  });

  route('POST', '/api/v1/customer/orders/:id/cancel', ['CUSTOMER'], async ({ user, params, body }) => {
    const order = await database.q('SELECT id FROM orders WHERE id=? AND user_id=?').get(params[0], user.id);
    if (!order) throw new HttpError(404, 'Order not found');
    const note = text(body.reason, 300, 'কারণ', { required: false });
    const status = await lifecycle.applyParentStatus(order.id, 'CANCELLED', user.id, note, { onlyIfAllCancellable: true });
    return ok({ id: order.id, status });
  });

  route('POST', '/api/v1/customer/orders/:id/refund-request', ['CUSTOMER'], async ({ user, params, body }) => {
    const reason = text(body.reason, 300, 'রিফান্ডের কারণ');
    const requestedAmount = body.amount_bdt !== undefined && body.amount_bdt !== '' && body.amount_bdt !== null
      ? (() => {
          const n = Number(body.amount_bdt);
          if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) throw new HttpError(400, 'রিফান্ড পরিমাণ সঠিক নয়');
          const p = Math.round(n * 100);
          if (!Number.isSafeInteger(p) || p <= 0) throw new HttpError(400, 'রিফান্ড পরিমাণ সঠিক নয়');
          return p;
        })()
      : null;
    const result = await database.tx(async () => {
      const order = await database.q('SELECT id,status,payment_status,total_paisa FROM orders WHERE id=? AND user_id=? FOR UPDATE').get(params[0], user.id);
      if (!order) throw new HttpError(404, 'Order not found');
      if (order.status !== 'DELIVERED') throw new HttpError(409, 'শুধু ডেলিভারি সম্পন্ন অর্ডারের জন্য রিফান্ড অনুরোধ করা যায়');
      if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.payment_status)) throw new HttpError(409, 'পেমেন্ট সম্পন্ন না হলে রিফান্ড অনুরোধ করা যায় না');
      const doneRow = await database.q("SELECT COALESCE(SUM(amount_paisa),0) AS s FROM refunds WHERE order_id=? AND status<>'REJECTED'").get(order.id);
      const remaining = Number(order.total_paisa) - Number(doneRow?.s || 0);
      if (remaining <= 0) throw new HttpError(409, 'এই অর্ডারের জন্য আগেই সম্পূর্ণ রিফান্ড অনুরোধ করা হয়েছে');
      const amt = requestedAmount === null ? remaining : requestedAmount;
      if (amt > remaining) throw new HttpError(409, 'রিফান্ড পরিমাণ অবশিষ্ট পরিশোধিত অংশের বেশি');
      const rid = id(), ts = now();
      await database.q("INSERT INTO refunds(id,order_id,amount_paisa,reason,status,created_at,decided_at) VALUES(?,?,?,?,'REQUESTED',?,NULL)")
        .run(rid, order.id, amt, reason, ts);
      await writeAudit(database, user.id, 'REFUND_REQUEST', 'refund', rid, { order_id: order.id, amount_paisa: amt });
      const admins = await database.q("SELECT id FROM users WHERE role='ADMIN' AND status='ACTIVE'").all();
      for (const a of admins) await notify(database, a.id, 'নতুন রিফান্ড অনুরোধ', orderNumber(order.id) + ': ' + money(amt) + ' টাকা');
      return { id: rid, order_id: order.id, orderNumber: orderNumber(order.id), amount_bdt: money(amt), status: 'REQUESTED', reason };
    });
    return ok(result, 201);
  });

  route('GET', '/api/v1/seller/orders', ['SELLER'], async ({ user, url }) => {
    const status = url.searchParams.get('status');
    const rows = await database.q(`SELECT so.id,so.order_id,so.status,so.subtotal_paisa,so.commission_paisa,so.net_paisa,so.created_at,
        o.delivery_name,o.delivery_phone,o.delivery_address,o.delivery_area,o.customer_note,
        u.name AS customer_name,u.phone AS customer_phone,
        COALESCE((
          SELECT json_agg(json_build_object(
            'name_bn',oi.product_name_bn,'quantity',oi.quantity,
            'unit_price_bdt',oi.unit_price_paisa::numeric/100,'variant',oi.variant
          ) ORDER BY oi.id)
          FROM order_items oi WHERE oi.seller_order_id=so.id
        ),'[]'::json) AS items,
        sh.id AS shipment_id,sh.provider AS shipment_provider,sh.tracking_id AS shipment_tracking_id,
        sh.status AS shipment_status,sh.mode AS shipment_mode
      FROM seller_orders so
      JOIN orders o ON o.id=so.order_id
      LEFT JOIN users u ON u.id=o.user_id
      LEFT JOIN LATERAL (
        SELECT id,provider,tracking_id,status,mode
        FROM shipments WHERE seller_order_id=so.id
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) sh ON TRUE
      WHERE so.seller_id=? AND so.status<>'AWAITING_PAYMENT'${status ? ' AND so.status=?' : ''}
      ORDER BY so.created_at DESC,so.id DESC LIMIT 200`).all(...(status ? [user.id, status] : [user.id]));
    return ok(rows.map(row => ({
      id: row.id, order_id: row.order_id, orderNumber: orderNumber(row.order_id), status: row.status,
      subtotal_bdt: money(row.subtotal_paisa), commission_bdt: money(row.commission_paisa),
      net_bdt: money(row.net_paisa), created_at: row.created_at,
      customer: { name: row.customer_name, phone: row.customer_phone },
      delivery: {
        name: row.delivery_name, phone: row.delivery_phone, address: row.delivery_address,
        area: row.delivery_area, note: row.customer_note
      },
      items: (Array.isArray(row.items) ? row.items : []).map(item => ({
        name_bn: item.name_bn, quantity: Number(item.quantity),
        unit_price_bdt: Number(item.unit_price_bdt), variant: item.variant || ''
      })),
      shipment: row.shipment_tracking_id ? {
        id: row.shipment_id, provider: row.shipment_provider, tracking_id: row.shipment_tracking_id,
        status: row.shipment_status, mode: row.shipment_mode
      } : null
    })));
  });

  route('POST', '/api/v1/seller/orders/:id/status', ['SELLER'], async ({ user, params, body }) => {
    const next = String(body.status || '');
    if (!['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(next)) throw new HttpError(400, 'Invalid seller order status');
    const sellerProfile = await database.q('SELECT status FROM seller_profiles WHERE user_id=?').get(user.id);
    if (sellerProfile?.status !== 'APPROVED') throw new HttpError(403, 'বিক্রেতা অনুমোদিত না থাকলে অর্ডারের অবস্থা পরিবর্তন করা যাবে না');
    const owned = await database.q('SELECT id FROM seller_orders WHERE id=? AND seller_id=?').get(params[0], user.id);
    if (!owned) throw new HttpError(404, 'Seller order not found');
    const note = text(body.note, 300, 'নোট', { required: false });
    const parentStatus = await lifecycle.applySellerStatus(owned.id, next, user.id, note);
    return ok({ id: owned.id, status: next, parent_status: parentStatus });
  });

  route('GET', '/api/v1/admin/orders', ['ADMIN'], async ({ url }) => {
    const status = url.searchParams.get('status');
    const qTerm = String(url.searchParams.get('q') || '').trim().slice(0, 80);
    const clauses = [], params = [];
    if (status) { clauses.push('o.status=?'); params.push(status); }
    if (qTerm) {
      const like = '%' + qTerm + '%';
      clauses.push('(o.id ILIKE ? OR COALESCE(u.name,\'\') ILIKE ? OR COALESCE(u.phone,\'\') ILIKE ?)');
      params.push('%' + qTerm.replace(/^HAAT-/i, '') + '%', like, like);
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = await database.q(`SELECT o.id,o.user_id,o.total_paisa,o.status,o.payment_method,o.payment_status,o.created_at,
      o.delivery_name,o.delivery_phone,o.delivery_address,o.delivery_area,o.customer_note,
      u.name AS customer_name,u.phone AS customer_phone,u.email AS customer_email,
      COALESCE((
        SELECT json_agg(json_build_object('name_bn',oi.product_name_bn,'quantity',oi.quantity,'unit_price_bdt',oi.unit_price_paisa::numeric/100) ORDER BY oi.id)
        FROM order_items oi WHERE oi.order_id=o.id
      ),'[]'::json) AS items
      FROM orders o LEFT JOIN users u ON u.id=o.user_id${where}
      ORDER BY o.created_at DESC,o.id DESC LIMIT 300`).all(...params);
    return ok(rows.map(row => ({
      id: row.id,
      orderNumber: orderNumber(row.id),
      customer_id: row.user_id,
      total_bdt: money(row.total_paisa),
      status: row.status,
      payment: { method: row.payment_method, status: row.payment_status },
      created_at: row.created_at,
      customer: { name: row.customer_name || '', phone: row.customer_phone || '', email: row.customer_email || null },
      delivery: { name: row.delivery_name || '', phone: row.delivery_phone || '', address: row.delivery_address || '', area: row.delivery_area || '', note: row.customer_note || '' },
      items: Array.isArray(row.items) ? row.items : []
    })));
  });

  route('POST', '/api/v1/admin/orders/:id/status', ['ADMIN'], async ({ user, params, body }) => {
    const next = String(body.status || '');
    if (!['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(next)) throw new HttpError(400, 'Invalid order status');
    const order = await database.q('SELECT id FROM orders WHERE id=?').get(params[0]);
    if (!order) throw new HttpError(404, 'Order not found');
    const note = text(body.note, 300, 'নোট', { required: false });
    const status = await lifecycle.applyParentStatus(order.id, next, user.id, note);
    return ok({ id: order.id, status });
  });

  registerPostgresInventoryRoutes(route, ok, {
    database,
    inventoryRepository: options.inventoryRepository
  });

  return Object.freeze({ checkout, lifecycle });
}
