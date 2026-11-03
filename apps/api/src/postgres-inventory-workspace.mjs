import { randomUUID } from 'node:crypto';
import { HttpError, text, now as defaultNow } from './postgres-shared.mjs';

const MAX_STOCK = 1000000;
const money = value => Number(value || 0) / 100;
const isoDay = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;

function parseAdjustment(body = {}) {
  const delta = Number(body.delta);
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 20) {
    throw new HttpError(400, 'একবারে সর্বোচ্চ ২০টি স্টক যোগ বা কমানোর অনুরোধ করা যাবে');
  }
  const reason = text(body.reason, 300, 'কারণ');
  const key = String(body.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new HttpError(400, 'সঠিক idempotency key দিতে হবে');
  return { delta, reason, key };
}

export function createPostgresInventoryWorkspace(database, options = {}) {
  if (!database?.q || !database?.tx) throw new TypeError('PostgreSQL database is required');
  const id = options.id || randomUUID;
  const now = options.now || defaultNow;
  const q = sql => database.q(sql);

  async function sellerInventory(userId) {
    const rows = await q(`SELECT p.id,p.name_bn,p.name_en,p.sku,p.stock,p.price_paisa,p.active,p.status,p.updated_at,
      (p.stock <= 5) AS low_stock
      FROM products p JOIN seller_profiles sp ON sp.user_id=p.seller_id
      WHERE p.seller_id=? AND sp.status='APPROVED'
      ORDER BY (p.stock <= 5) DESC,p.updated_at DESC,p.id DESC LIMIT 300`).all(userId);
    return rows.map(row => ({ ...row, price_bdt: money(row.price_paisa), low_stock: Boolean(row.low_stock) }));
  }

  async function movements(userId, productId) {
    const owned = await q(`SELECT id FROM products WHERE id=? AND seller_id=?`).get(productId, userId);
    if (!owned) throw new HttpError(404, 'পণ্যটি পাওয়া যায়নি');
    return q(`SELECT id,quantity_delta,stock_before,stock_after,reason,created_at
      FROM inventory_movements WHERE seller_id=? AND product_id=?
      ORDER BY created_at DESC,id DESC LIMIT 100`).all(userId, productId);
  }

  async function requestAdjustment(user, productId, body) {
    const { delta, reason, key } = parseAdjustment(body);
    return database.tx(async () => {
      const product = await q(`SELECT p.id FROM products p JOIN seller_profiles sp ON sp.user_id=p.seller_id
        WHERE p.id=? AND p.seller_id=? AND sp.status='APPROVED' FOR UPDATE OF p`).get(productId, user.id);
      if (!product) throw new HttpError(404, 'পণ্যটি আপনার অনুমোদিত inventory-তে নেই');
      const prior = await q(`SELECT id,status,quantity_delta,reason,created_at FROM inventory_adjustment_requests
        WHERE seller_id=? AND idempotency_key=?`).get(user.id, key);
      if (prior) return { ...prior, duplicate: true };
      const request = { id: id(), product_id: productId, seller_id: user.id, requested_by: user.id,
        quantity_delta: delta, reason, idempotency_key: key, status: 'PENDING', created_at: now() };
      await q(`INSERT INTO inventory_adjustment_requests
        (id,product_id,seller_id,requested_by,quantity_delta,reason,idempotency_key,status,created_at)
        VALUES(?,?,?,?,?,?,?,'PENDING',?)`).run(request.id, request.product_id, request.seller_id,
        request.requested_by, request.quantity_delta, request.reason, request.idempotency_key, request.created_at);
      await q(`INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(id(), user.id, 'INVENTORY_ADJUSTMENT_REQUESTED', 'product', productId,
        JSON.stringify({ request_id: request.id, delta, reason }), request.created_at);
      return { ...request, duplicate: false };
    });
  }

  async function pendingRequests(status = 'PENDING') {
    const safeStatus = ['PENDING','APPROVED','REJECTED'].includes(status) ? status : 'PENDING';
    return q(`SELECT r.id,r.product_id,r.seller_id,r.quantity_delta,r.reason,r.status,r.created_at,
      p.name_bn AS product_name,s.shop_name,u.name AS seller_name,u.phone AS seller_phone
      FROM inventory_adjustment_requests r JOIN products p ON p.id=r.product_id
      JOIN seller_profiles s ON s.user_id=r.seller_id JOIN users u ON u.id=r.seller_id
      WHERE r.status=? ORDER BY r.created_at ASC,r.id ASC LIMIT 300`).all(safeStatus);
  }

  async function decideRequest(admin, requestId, body) {
    const decision = String(body.decision || '').toUpperCase();
    if (!['APPROVE','REJECT'].includes(decision)) throw new HttpError(400, 'সিদ্ধান্ত APPROVE অথবা REJECT হতে হবে');
    const note = text(body.note || (decision === 'APPROVE' ? 'অনুমোদিত' : 'প্রত্যাখ্যাত'), 300, 'নোট');
    return database.tx(async () => {
      const request = await q(`SELECT * FROM inventory_adjustment_requests WHERE id=? FOR UPDATE`).get(requestId);
      if (!request) throw new HttpError(404, 'অনুরোধ পাওয়া যায়নি');
      if (request.status !== 'PENDING') throw new HttpError(409, 'এই অনুরোধের সিদ্ধান্ত আগেই দেওয়া হয়েছে');
      const decidedAt = now();
      let stock = null;
      if (decision === 'APPROVE') {
        const product = await q(`SELECT p.id,p.stock,p.seller_id FROM products p
          JOIN seller_profiles sp ON sp.user_id=p.seller_id
          WHERE p.id=? AND p.seller_id=? AND sp.status='APPROVED' FOR UPDATE OF p`).get(request.product_id, request.seller_id);
        if (!product) throw new HttpError(409, 'বিক্রেতা বা পণ্য আর অনুমোদিত অবস্থায় নেই');
        const before = Number(product.stock), after = before + Number(request.quantity_delta);
        if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || after < 0 || after > MAX_STOCK) {
          throw new HttpError(409, 'অনুমোদনের ফলে স্টক গ্রহণযোগ্য সীমার বাইরে যাবে');
        }
        await q('UPDATE products SET stock=?,updated_at=? WHERE id=? AND seller_id=?')
          .run(after, decidedAt, product.id, request.seller_id);
        await q(`INSERT INTO inventory_movements
          (id,product_id,seller_id,actor_id,quantity_delta,stock_before,stock_after,reason,idempotency_key,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id(), product.id, request.seller_id, admin.id,
          request.quantity_delta, before, after, note + ' — ' + request.reason,
          'admin-approval:' + request.id, decidedAt);
        stock = { before, after };
      }
      const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      await q(`UPDATE inventory_adjustment_requests SET status=?,decided_by=?,decision_note=?,decided_at=? WHERE id=?`)
        .run(status, admin.id, note, decidedAt, request.id);
      await q(`INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(id(), admin.id, 'INVENTORY_ADJUSTMENT_' + status, 'inventory_adjustment_request',
        request.id, JSON.stringify({ product_id: request.product_id, seller_id: request.seller_id,
          delta: request.quantity_delta, stock, note }), decidedAt);
      await q(`INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)`)
        .run(id(), request.seller_id, status === 'APPROVED' ? 'স্টক পরিবর্তন অনুমোদিত' : 'স্টক পরিবর্তন প্রত্যাখ্যাত',
          status === 'APPROVED' ? 'নতুন স্টক: ' + stock.after : 'কারণ: ' + note, decidedAt);
      return { id: request.id, status, stock };
    });
  }

  async function alerts({ sellerId = null, threshold = 5 } = {}) {
    const limit = Number(threshold);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) throw new HttpError(400, 'সতর্কতার threshold ০–১০০০ হতে হবে');
    const rows = sellerId
      ? await q(`SELECT p.id,p.name_bn,p.name_en,p.stock,p.price_paisa,p.seller_id,s.shop_name
        FROM products p LEFT JOIN seller_profiles s ON s.user_id=p.seller_id
        WHERE p.active=1 AND p.stock<=? AND p.seller_id=?
        ORDER BY p.stock ASC,p.name_bn ASC LIMIT 500`).all(limit, sellerId)
      : await q(`SELECT p.id,p.name_bn,p.name_en,p.stock,p.price_paisa,p.seller_id,s.shop_name
        FROM products p LEFT JOIN seller_profiles s ON s.user_id=p.seller_id
        WHERE p.active=1 AND p.stock<=?
        ORDER BY p.stock ASC,p.name_bn ASC LIMIT 500`).all(limit);
    return rows.map(row => ({ ...row, price_bdt: money(row.price_paisa), low_stock: true }));
  }

  async function report({ sellerId = null, from = null, to = null } = {}) {
    const start = isoDay(from), end = isoDay(to);
    if ((from && !start) || (to && !end) || (start && end && start > end)) throw new HttpError(400, 'রিপোর্টের তারিখ সঠিক নয়');
    const filter = sellerId ? ' AND seller_id=?' : '';
    const params = sellerId ? [sellerId] : [];
    const summary = await q(`SELECT COUNT(*)::int AS product_count,
      COALESCE(SUM(stock),0)::bigint AS units_in_stock,
      COALESCE(SUM(stock * price_paisa),0)::bigint AS stock_value_paisa,
      COUNT(*) FILTER (WHERE stock<=5)::int AS low_stock_products
      FROM products WHERE active=1${filter}`).get(...params);
    const movementParams = [];
    let movementWhere = 'WHERE created_at >= COALESCE(?, \'0001-01-01\') AND created_at < COALESCE(to_char(?::date + INTERVAL \'1 day\', \'YYYY-MM-DD\'), \'9999-12-31\')';
    movementParams.push(start, end);
    if (sellerId) { movementWhere += ' AND seller_id=?'; movementParams.push(sellerId); }
    const totals = await q(`SELECT COUNT(*)::int AS movement_count,
      COALESCE(SUM(quantity_delta) FILTER (WHERE quantity_delta>0),0)::bigint AS units_added,
      COALESCE(SUM(-quantity_delta) FILTER (WHERE quantity_delta<0),0)::bigint AS units_removed
      FROM inventory_movements ${movementWhere}`).get(...movementParams);
    return { ...summary, stock_value_bdt: money(summary.stock_value_paisa), ...totals,
      from: start, to: end };
  }

  return Object.freeze({ sellerInventory, movements, requestAdjustment, pendingRequests, decideRequest, alerts, report });
}

export async function handlePostgresInventoryWorkspace({ database, user, method, path, url, body = {} }) {
  const workspace = createPostgresInventoryWorkspace(database);
  const seller = user?.role === 'SELLER', admin = user?.role === 'ADMIN';
  if (!seller && !admin) throw new HttpError(403, 'এই অপারেশনের অনুমতি নেই');
  const productMovement = path.match(/^\/api\/v1\/seller\/inventory\/([^/]+)\/movements$/);
  const requestDecision = path.match(/^\/api\/v1\/admin\/inventory\/adjustments\/([^/]+)\/decision$/);
  const adjustmentRequest = path.match(/^\/api\/v1\/seller\/inventory\/([^/]+)\/adjust-requests$/);
  if (seller && method === 'GET' && path === '/api/v1/seller/inventory') return { data: await workspace.sellerInventory(user.id) };
  if (seller && method === 'GET' && productMovement) return { data: await workspace.movements(user.id, decodeURIComponent(productMovement[1])) };
  if (seller && method === 'POST' && adjustmentRequest) return { data: await workspace.requestAdjustment(user, decodeURIComponent(adjustmentRequest[1]), body), status: 201 };
  if (admin && method === 'GET' && path === '/api/v1/admin/inventory/adjustments') return { data: await workspace.pendingRequests(url.searchParams.get('status') || 'PENDING') };
  if (admin && method === 'POST' && requestDecision) return { data: await workspace.decideRequest(user, decodeURIComponent(requestDecision[1]), body) };
  if (seller && method === 'GET' && path === '/api/v1/seller/inventory/alerts') return { data: await workspace.alerts({ sellerId: user.id, threshold: url.searchParams.get('threshold') || 5 }) };
  if (admin && method === 'GET' && path === '/api/v1/admin/inventory/alerts') return { data: await workspace.alerts({ threshold: url.searchParams.get('threshold') || 5 }) };
  if (seller && method === 'GET' && path === '/api/v1/seller/inventory/report') return { data: await workspace.report({ sellerId: user.id, from: url.searchParams.get('from'), to: url.searchParams.get('to') }) };
  if (admin && method === 'GET' && path === '/api/v1/admin/inventory/report') return { data: await workspace.report({ from: url.searchParams.get('from'), to: url.searchParams.get('to') }) };
  if (admin && path.startsWith('/api/v1/admin/inventory/')) throw new HttpError(405, 'Method not allowed');
  if (seller && path.startsWith('/api/v1/seller/inventory/')) throw new HttpError(405, 'Method not allowed');
  return null;
}
