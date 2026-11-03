import { id, now, HttpError, text } from './postgres-shared.mjs';
import { createPostgresCheckoutRepository } from './postgres-checkout.mjs';
import { createPostgresOrderLifecycleRepository } from './postgres-orders.mjs';

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
    shippingFor: options.shippingFor || (async () => 0),
    couponFor: options.couponFor,
    paymentMethods: options.paymentMethods || ['COD'],
    startPayment: options.startPayment,
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

  route('GET', '/api/v1/seller/orders', ['SELLER'], async ({ user, url }) => {
    const status = url.searchParams.get('status');
    const rows = await database.q(`SELECT so.id,so.order_id,so.status,so.subtotal_paisa,so.commission_paisa,so.net_paisa,so.created_at
      FROM seller_orders so WHERE so.seller_id=? AND so.status<>'AWAITING_PAYMENT'${status ? ' AND so.status=?' : ''}
      ORDER BY so.created_at DESC,so.id DESC LIMIT 200`).all(...(status ? [user.id, status] : [user.id]));
    return ok(rows.map(row => ({ id: row.id, order_id: row.order_id, orderNumber: orderNumber(row.order_id), status: row.status, subtotal_bdt: money(row.subtotal_paisa), commission_bdt: money(row.commission_paisa), net_bdt: money(row.net_paisa), created_at: row.created_at })));
  });

  route('POST', '/api/v1/seller/orders/:id/status', ['SELLER'], async ({ user, params, body }) => {
    const next = String(body.status || '');
    if (!['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(next)) throw new HttpError(400, 'Invalid seller order status');
    const owned = await database.q('SELECT id FROM seller_orders WHERE id=? AND seller_id=?').get(params[0], user.id);
    if (!owned) throw new HttpError(404, 'Seller order not found');
    const note = text(body.note, 300, 'নোট', { required: false });
    const parentStatus = await lifecycle.applySellerStatus(owned.id, next, user.id, note);
    return ok({ id: owned.id, status: next, parent_status: parentStatus });
  });

  route('GET', '/api/v1/admin/orders', ['ADMIN'], async ({ url }) => {
    const status = url.searchParams.get('status');
    const rows = await database.q(`SELECT id,user_id,total_paisa,status,payment_method,payment_status,created_at
      FROM orders${status ? ' WHERE status=?' : ''} ORDER BY created_at DESC,id DESC LIMIT 300`).all(...(status ? [status] : []));
    return ok(rows.map(row => ({ id: row.id, orderNumber: orderNumber(row.id), customer_id: row.user_id, total_bdt: money(row.total_paisa), status: row.status, payment: { method: row.payment_method, status: row.payment_status }, created_at: row.created_at })));
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

  return Object.freeze({ checkout, lifecycle });
}
