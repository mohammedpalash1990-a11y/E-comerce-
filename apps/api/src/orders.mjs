import { q, tx, id, now, audit, notify, HttpError, bdt, orderNo } from './core.mjs';

export const TRANSITIONS = { AWAITING_PAYMENT: ['CONFIRMED', 'CANCELLED'], CONFIRMED: ['PROCESSING', 'CANCELLED'], PROCESSING: ['SHIPPED', 'CANCELLED'], SHIPPED: ['DELIVERED'] };
export const conflict = () => new HttpError(409, 'এই অর্ডারের বর্তমান অবস্থা থেকে এই পরিবর্তন করা যাবে না');

export function addEvent(orderId, soId, status, note, actor) {
  q('INSERT INTO order_events VALUES(?,?,?,?,?,?,?)').run(id(), orderId, soId || null, status, note || '', actor || null, now());
}

export function recomputeParent(orderId) {
  const st = q('SELECT status FROM seller_orders WHERE order_id=?').all(orderId).map(r => r.status);
  const cur = q('SELECT status,payment_method,payment_status,total_paisa,user_id FROM orders WHERE id=?').get(orderId);
  if (!st.length) return cur.status;
  let p = 'CONFIRMED';
  if (st.every(s => s === 'CANCELLED')) p = 'CANCELLED';
  else if (st.every(s => ['DELIVERED', 'CANCELLED'].includes(s))) p = 'DELIVERED';
  else if (st.some(s => ['SHIPPED', 'DELIVERED'].includes(s))) p = 'SHIPPED';
  else if (st.some(s => s === 'PROCESSING')) p = 'PROCESSING';
  else if (st.every(s => ['AWAITING_PAYMENT', 'CANCELLED'].includes(s))) p = 'AWAITING_PAYMENT';
  if (p !== cur.status) { q('UPDATE orders SET status=? WHERE id=?').run(p, orderId); }
  if (p === 'DELIVERED' && cur.payment_method === 'COD' && cur.payment_status !== 'PAID') {
    q("UPDATE orders SET payment_status='PAID' WHERE id=?").run(orderId);
    q("UPDATE payments SET status='PAID',updated_at=? WHERE order_id=? AND method='COD'").run(now(), orderId);
    q("INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(id(), 'ORDER_PAYMENT', orderId, null, null, cur.total_paisa, 'cod:' + orderId, now());
  }
  if (p === 'CANCELLED' && cur.payment_status === 'PAID') ensureRefund(orderId, cur.total_paisa, 'অর্ডার বাতিল');
  return p;
}

function ensureRefund(orderId, cap, reason) {
  const done = q("SELECT COALESCE(SUM(amount_paisa),0) s FROM refunds WHERE order_id=? AND status<>'REJECTED'").get(orderId).s;
  if (cap - done > 0) q('INSERT INTO refunds VALUES(?,?,?,?,?,?,NULL)').run(id(), orderId, cap - done, reason, 'REQUESTED', now());
}

// Single place where a seller sub-order changes state. Stock is restored at most once because
// CANCELLED is a terminal state that cannot be entered twice.
export function applySellerStatus(so, next, actor, note) {
  if (!(TRANSITIONS[so.status] || []).includes(next)) throw conflict();
  if (next === 'CANCELLED') {
    for (const it of q('SELECT product_id,quantity FROM order_items WHERE seller_order_id=?').all(so.id)) q('UPDATE products SET stock=stock+? WHERE id=?').run(it.quantity, it.product_id);
    const o = q('SELECT payment_status,payment_method FROM orders WHERE id=?').get(so.order_id);
    const others = q("SELECT COUNT(*) n FROM seller_orders WHERE order_id=? AND id<>? AND status<>'CANCELLED'").get(so.order_id, so.id).n;
    // When the last sub-order is cancelled, recomputeParent raises a single full refund instead.
    if (o.payment_status === 'PAID' && o.payment_method !== 'COD' && others > 0) {
      const done = q("SELECT COALESCE(SUM(amount_paisa),0) s FROM refunds WHERE order_id=? AND status<>'REJECTED'").get(so.order_id).s;
      const total = q('SELECT total_paisa FROM orders WHERE id=?').get(so.order_id).total_paisa;
      const amt = Math.min(so.subtotal_paisa, total - done);
      if (amt > 0) q('INSERT INTO refunds VALUES(?,?,?,?,?,?,NULL)').run(id(), so.order_id, amt, 'বিক্রেতা অর্ডার বাতিল', 'REQUESTED', now());
    }
  }
  q('UPDATE seller_orders SET status=? WHERE id=?').run(next, so.id);
  if (next === 'DELIVERED') {
    q('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(id(), 'SELLER_EARNING', so.order_id, so.id, so.seller_id, so.net_paisa, so.id, now());
    q('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(id(), 'COMMISSION', so.order_id, so.id, so.seller_id, so.commission_paisa, so.id, now());
  }
  addEvent(so.order_id, so.id, next, note, actor);
  audit(actor, 'ORDER_STATUS_' + next, 'seller_order', so.id, { from: so.status, order_id: so.order_id });
  const owner = q('SELECT user_id FROM orders WHERE id=?').get(so.order_id).user_id;
  notify(owner, 'অর্ডার ' + orderNo(so.order_id), 'স্ট্যাটাস: ' + next);
  const parent = recomputeParent(so.order_id);
  q('UPDATE orders SET status=? WHERE id=?').run(parent, so.order_id);
  return parent;
}

// Parent-level change (admin or customer): applied to every sub-order that is allowed to move.
export function applyParentStatus(orderId, next, actor, note, { onlyIfAllCancellable = false } = {}) {
  return tx(() => {
    const o = q('SELECT id,status FROM orders WHERE id=?').get(orderId);
    if (!o) throw new HttpError(404, 'Order not found');
    if (!(TRANSITIONS[o.status] || []).includes(next)) throw conflict();
    const subs = q('SELECT * FROM seller_orders WHERE order_id=?').all(orderId);
    if (onlyIfAllCancellable && subs.some(s => !['CONFIRMED', 'AWAITING_PAYMENT'].includes(s.status))) throw conflict();
    let moved = 0;
    for (const s of subs) if ((TRANSITIONS[s.status] || []).includes(next)) { applySellerStatus(s, next, actor, note); moved++; }
    if (!subs.length) { // legacy order without sub-orders
      if (next === 'CANCELLED') for (const it of q('SELECT product_id,quantity FROM order_items WHERE order_id=?').all(orderId)) q('UPDATE products SET stock=stock+? WHERE id=?').run(it.quantity, it.product_id);
      q('UPDATE orders SET status=? WHERE id=?').run(next, orderId); addEvent(orderId, null, next, note, actor); moved++;
    }
    if (!moved) throw conflict();
    audit(actor, 'ORDER_PARENT_' + next, 'order', orderId, { note: note || '' });
    return q('SELECT status FROM orders WHERE id=?').get(orderId).status;
  });
}

// ---- balances (single source of truth: transactions + payouts + seller_orders) ----
export function sellerBalance(sellerId) {
  const earn = q("SELECT COALESCE(SUM(amount_paisa),0) s FROM transactions WHERE seller_id=? AND kind IN('SELLER_EARNING','SELLER_REVERSAL')").get(sellerId).s;
  const comm = q("SELECT COALESCE(SUM(amount_paisa),0) s FROM transactions WHERE seller_id=? AND kind='COMMISSION'").get(sellerId).s;
  const gross = q("SELECT COALESCE(SUM(subtotal_paisa),0) s FROM seller_orders WHERE seller_id=? AND status='DELIVERED'").get(sellerId).s;
  const reserved = q("SELECT COALESCE(SUM(amount_paisa),0) s FROM payouts WHERE seller_id=? AND status IN('REQUESTED','APPROVED')").get(sellerId).s;
  const paid = q("SELECT COALESCE(SUM(amount_paisa),0) s FROM payouts WHERE seller_id=? AND status='APPROVED'").get(sellerId).s;
  const pending = q("SELECT COALESCE(SUM(net_paisa),0) s FROM seller_orders WHERE seller_id=? AND status IN('CONFIRMED','PROCESSING','SHIPPED')").get(sellerId).s;
  return { total_sales_bdt: bdt(gross), commission_bdt: bdt(comm), net_earnings_bdt: bdt(earn), pending_balance_bdt: bdt(pending), available_balance_bdt: bdt(earn - reserved), paid_out_bdt: bdt(paid), available_paisa: earn - reserved };
}

export function orderView(o, { forSeller } = {}) {
  const items = q('SELECT product_id,product_name_bn,quantity,unit_price_paisa,variant,seller_order_id FROM order_items WHERE order_id=?').all(o.id)
    .filter(i => !forSeller || i.seller_order_id === forSeller);
  return {
    id: o.id, orderNumber: orderNo(o.id), total_bdt: bdt(o.total_paisa), subtotal_bdt: bdt(o.subtotal_paisa), shipping_bdt: bdt(o.shipping_paisa), discount_bdt: bdt(o.discount_paisa),
    coupon_code: o.coupon_code, status: o.status, payment: { method: o.payment_method, status: o.payment_status }, created_at: o.created_at,
    delivery: { name: o.delivery_name, phone: o.delivery_phone, address: o.delivery_address, area: o.delivery_area, note: o.customer_note },
    items: items.map(i => ({ product_id: i.product_id, name_bn: i.product_name_bn, quantity: i.quantity, unit_price_bdt: bdt(i.unit_price_paisa), variant: i.variant }))
  };
}
