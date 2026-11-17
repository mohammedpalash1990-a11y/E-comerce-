import { q, tx, id, now, audit, notify, text, HttpError, bdt } from './core.mjs';

const MAX_STOCK = 1000000;
const isoDay = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null);

function parseAdjustment(body = {}) {
  const delta = Number(body.delta);
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 20) {
    throw new HttpError(400, 'একবারে সর্বোচ্চ ২০টি স্টক যোগ বা কমানোর অনুরোধ করা যাবে');
  }
  const reason = text(body.reason, 300, 'কারণ');
  const key = String(body.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
    throw new HttpError(400, 'সঠিক idempotency key দিতে হবে');
  }
  return { delta, reason, key };
}

export function sellerInventory(userId) {
  const rows = q(`SELECT p.id,p.name_bn,p.name_en,p.sku,p.stock,p.price_paisa,p.active,p.status,p.updated_at,
    (p.stock <= 5) AS low_stock
    FROM products p JOIN seller_profiles sp ON sp.user_id=p.seller_id
    WHERE p.seller_id=? AND sp.status='APPROVED' AND p.status<>'ARCHIVED'
    ORDER BY (p.stock <= 5) DESC,p.updated_at DESC,p.id DESC LIMIT 300`).all(userId);
  return rows.map(row => ({ ...row, price_bdt: bdt(row.price_paisa), low_stock: Boolean(row.low_stock) }));
}

export function productMovements(userId, productId) {
  const owned = q('SELECT id FROM products WHERE id=? AND seller_id=?').get(productId, userId);
  if (!owned) throw new HttpError(404, 'পণ্যটি পাওয়া যায়নি');
  return q(`SELECT id,quantity_delta,stock_before,stock_after,reason,created_at
    FROM inventory_movements WHERE seller_id=? AND product_id=?
    ORDER BY created_at DESC,id DESC LIMIT 100`).all(userId, productId);
}

export function requestAdjustment(user, productId, body) {
  const { delta, reason, key } = parseAdjustment(body);
  return tx(() => {
    const product = q(`SELECT p.id FROM products p JOIN seller_profiles sp ON sp.user_id=p.seller_id
      WHERE p.id=? AND p.seller_id=? AND sp.status='APPROVED' AND p.status<>'ARCHIVED'`).get(productId, user.id);
    if (!product) throw new HttpError(404, 'পণ্যটি আপনার অনুমোদিত inventory-তে নেই');
    const prior = q(`SELECT id,status,quantity_delta,reason,created_at FROM inventory_adjustment_requests
      WHERE seller_id=? AND idempotency_key=?`).get(user.id, key);
    if (prior) return { ...prior, duplicate: true };
    const req = {
      id: id(),
      product_id: productId,
      seller_id: user.id,
      requested_by: user.id,
      quantity_delta: delta,
      reason,
      idempotency_key: key,
      status: 'PENDING',
      created_at: now()
    };
    q(`INSERT INTO inventory_adjustment_requests
      (id,product_id,seller_id,requested_by,quantity_delta,reason,idempotency_key,status,created_at)
      VALUES(?,?,?,?,?,?,?,'PENDING',?)`).run(
      req.id, req.product_id, req.seller_id, req.requested_by, req.quantity_delta, req.reason, req.idempotency_key, req.created_at
    );
    audit(user.id, 'INVENTORY_ADJUSTMENT_REQUESTED', 'product', productId, { request_id: req.id, delta, reason });
    return { ...req, duplicate: false };
  });
}

export function pendingRequests(status = 'PENDING') {
  const safeStatus = ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? status : 'PENDING';
  return q(`SELECT r.id,r.product_id,r.seller_id,r.quantity_delta,r.reason,r.status,r.decision_note,r.created_at,r.decided_at,
    p.name_bn AS product_name,s.shop_name,u.name AS seller_name,u.phone AS seller_phone
    FROM inventory_adjustment_requests r JOIN products p ON p.id=r.product_id
    JOIN seller_profiles s ON s.user_id=r.seller_id JOIN users u ON u.id=r.seller_id
    WHERE r.status=? ORDER BY r.created_at ASC,r.id ASC LIMIT 300`).all(safeStatus);
}

export function decideRequest(admin, requestId, body = {}) {
  const decision = String(body.decision || '').toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(decision)) {
    throw new HttpError(400, 'সিদ্ধান্ত APPROVE অথবা REJECT হতে হবে');
  }
  const note = text(body.note || (decision === 'APPROVE' ? 'অনুমোদিত' : 'প্রত্যাখ্যাত'), 300, 'নোট');
  return tx(() => {
    const req = q('SELECT * FROM inventory_adjustment_requests WHERE id=?').get(requestId);
    if (!req) throw new HttpError(404, 'অনুরোধ পাওয়া যায়নি');
    if (req.status !== 'PENDING') throw new HttpError(409, 'এই অনুরোধের সিদ্ধান্ত আগেই দেওয়া হয়েছে');
    const decidedAt = now();
    let stock = null;
    if (decision === 'APPROVE') {
      const product = q(`SELECT p.id,p.stock,p.seller_id FROM products p
        JOIN seller_profiles sp ON sp.user_id=p.seller_id
        WHERE p.id=? AND p.seller_id=? AND sp.status='APPROVED' AND p.status<>'ARCHIVED'`).get(req.product_id, req.seller_id);
      if (!product) throw new HttpError(409, 'বিক্রেতা বা পণ্য আর অনুমোদিত অবস্থায় নেই');
      const before = Number(product.stock);
      const after = before + Number(req.quantity_delta);
      if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || after < 0 || after > MAX_STOCK) {
        throw new HttpError(409, 'অনুমোদনের ফলে স্টক গ্রহণযোগ্য সীমার বাইরে যাবে');
      }
      q('UPDATE products SET stock=?,updated_at=? WHERE id=? AND seller_id=?').run(after, decidedAt, product.id, req.seller_id);
      q(`INSERT INTO inventory_movements
        (id,product_id,seller_id,actor_id,quantity_delta,stock_before,stock_after,reason,idempotency_key,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        id(), product.id, req.seller_id, admin.id, req.quantity_delta, before, after,
        note + ' — ' + req.reason, 'admin-approval:' + req.id, decidedAt
      );
      stock = { before, after };
    }
    const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    q('UPDATE inventory_adjustment_requests SET status=?,decided_by=?,decision_note=?,decided_at=? WHERE id=?')
      .run(status, admin.id, note, decidedAt, req.id);
    audit(admin.id, 'INVENTORY_ADJUSTMENT_' + status, 'inventory_adjustment_request', req.id, {
      product_id: req.product_id, seller_id: req.seller_id, delta: req.quantity_delta, stock, note
    });
    notify(
      req.seller_id,
      status === 'APPROVED' ? 'স্টক পরিবর্তন অনুমোদিত' : 'স্টক পরিবর্তন প্রত্যাখ্যাত',
      status === 'APPROVED' ? 'নতুন স্টক: ' + stock.after : 'কারণ: ' + note
    );
    return { id: req.id, status, stock };
  });
}

export function inventoryAlerts({ sellerId = null, threshold = 5 } = {}) {
  const limit = Number(threshold);
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
    throw new HttpError(400, 'সতর্কতার threshold ০–১০০০ হতে হবে');
  }
  const rows = sellerId
    ? q(`SELECT p.id,p.name_bn,p.name_en,p.stock,p.price_paisa,p.seller_id,s.shop_name
      FROM products p LEFT JOIN seller_profiles s ON s.user_id=p.seller_id
      WHERE p.active=1 AND p.stock<=? AND p.seller_id=?
      ORDER BY p.stock ASC,p.name_bn ASC LIMIT 500`).all(limit, sellerId)
    : q(`SELECT p.id,p.name_bn,p.name_en,p.stock,p.price_paisa,p.seller_id,s.shop_name
      FROM products p LEFT JOIN seller_profiles s ON s.user_id=p.seller_id
      WHERE p.active=1 AND p.stock<=?
      ORDER BY p.stock ASC,p.name_bn ASC LIMIT 500`).all(limit);
  return rows.map(row => ({ ...row, price_bdt: bdt(row.price_paisa), low_stock: true }));
}

export function inventoryReport({ sellerId = null, from = null, to = null } = {}) {
  const start = isoDay(from);
  const end = isoDay(to);
  if ((from && !start) || (to && !end) || (start && end && start > end)) {
    throw new HttpError(400, 'রিপোর্টের তারিখ সঠিক নয়');
  }
  const filter = sellerId ? ' AND seller_id=?' : '';
  const params = sellerId ? [sellerId] : [];
  const summary = q(`SELECT COUNT(*) AS product_count,
    COALESCE(SUM(stock),0) AS units_in_stock,
    COALESCE(SUM(stock * price_paisa),0) AS stock_value_paisa,
    COALESCE(SUM(CASE WHEN stock<=5 THEN 1 ELSE 0 END),0) AS low_stock_products
    FROM products WHERE active=1${filter}`).get(...params);
  const movWhere = [];
  const movParams = [];
  if (start) { movWhere.push('substr(created_at,1,10)>=?'); movParams.push(start); }
  if (end) { movWhere.push('substr(created_at,1,10)<=?'); movParams.push(end); }
  if (sellerId) { movWhere.push('seller_id=?'); movParams.push(sellerId); }
  const whereClause = movWhere.length ? 'WHERE ' + movWhere.join(' AND ') : '';
  const totals = q(`SELECT COUNT(*) AS movement_count,
    COALESCE(SUM(CASE WHEN quantity_delta>0 THEN quantity_delta ELSE 0 END),0) AS units_added,
    COALESCE(SUM(CASE WHEN quantity_delta<0 THEN -quantity_delta ELSE 0 END),0) AS units_removed
    FROM inventory_movements ${whereClause}`).get(...movParams);
  return {
    product_count: Number(summary.product_count || 0),
    units_in_stock: Number(summary.units_in_stock || 0),
    stock_value_paisa: Number(summary.stock_value_paisa || 0),
    stock_value_bdt: bdt(Number(summary.stock_value_paisa || 0)),
    low_stock_products: Number(summary.low_stock_products || 0),
    movement_count: Number(totals.movement_count || 0),
    units_added: Number(totals.units_added || 0),
    units_removed: Number(totals.units_removed || 0),
    from: start,
    to: end
  };
}
