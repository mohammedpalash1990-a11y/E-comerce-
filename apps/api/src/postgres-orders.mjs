import { bad, HttpError, id as defaultId, now as defaultNow } from './postgres-shared.mjs';

export const POSTGRES_ORDER_TRANSITIONS = Object.freeze({
  AWAITING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED']
});

const conflict = () => new HttpError(409, 'এই অর্ডারের বর্তমান অবস্থা থেকে এই পরিবর্তন করা যাবে না');
const safeAmount = value => {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid paisa amount in order ledger');
  return amount;
};

export function createPostgresOrderLifecycleRepository(database, options = {}) {
  if (!database || typeof database.q !== 'function' || typeof database.tx !== 'function') {
    throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  }
  const query = sql => database.q(sql);
  const generateId = options.id || defaultId;
  const getNow = options.now || defaultNow;
  const notify = options.notify || (async () => {});
  const audit = options.audit || (async () => {});
  const orderNo = options.orderNo || (value => value);

  async function addEvent(orderId, sellerOrderId, status, note, actor) {
    await query('INSERT INTO order_events(id,order_id,seller_order_id,status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(generateId(), orderId, sellerOrderId || null, status, note || '', actor || null, getNow());
  }

  async function ensureRefund(orderId, cap, reason) {
    const row = await query("SELECT COALESCE(SUM(amount_paisa),0) amount FROM refunds WHERE order_id=? AND status<>'REJECTED'")
      .get(orderId);
    const alreadyRequested = safeAmount(row?.amount || 0);
    const remaining = safeAmount(cap) - alreadyRequested;
    if (remaining > 0) {
      await query("INSERT INTO refunds(id,order_id,amount_paisa,reason,status,created_at,decided_at) VALUES(?,?,?,?,?,?,NULL)")
        .run(generateId(), orderId, remaining, reason, 'REQUESTED', getNow());
    }
  }

  async function recomputeParent(orderId) {
    const states = await query('SELECT status FROM seller_orders WHERE order_id=?').all(orderId);
    const parent = await query('SELECT status,payment_method,payment_status,total_paisa,user_id FROM orders WHERE id=?').get(orderId);
    if (!parent) throw new HttpError(404, 'Order not found');
    if (!states.length) return parent.status;

    const status = states.map(row => row.status);
    let next = 'CONFIRMED';
    if (status.every(value => value === 'CANCELLED')) next = 'CANCELLED';
    else if (status.every(value => ['DELIVERED', 'CANCELLED'].includes(value))) next = 'DELIVERED';
    else if (status.some(value => ['SHIPPED', 'DELIVERED'].includes(value))) next = 'SHIPPED';
    else if (status.some(value => value === 'PROCESSING')) next = 'PROCESSING';
    else if (status.every(value => ['AWAITING_PAYMENT', 'CANCELLED'].includes(value))) next = 'AWAITING_PAYMENT';

    if (next === 'DELIVERED' && parent.payment_method === 'COD' && parent.payment_status !== 'PAID') {
      await query("UPDATE orders SET payment_status='PAID' WHERE id=?").run(orderId);
      await query("UPDATE payments SET status='PAID',updated_at=? WHERE order_id=? AND method='COD'")
        .run(getNow(), orderId);
      await query("INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .run(generateId(), 'ORDER_PAYMENT', orderId, null, null, safeAmount(parent.total_paisa), 'cod:' + orderId, getNow());
    }
    if (next === 'CANCELLED' && parent.payment_status === 'PAID') {
      await ensureRefund(orderId, safeAmount(parent.total_paisa), 'অর্ডার বাতিল');
    }
    await query('UPDATE orders SET status=? WHERE id=?').run(next, orderId);
    return next;
  }

  async function applySellerStatusInTransaction(sellerOrderId, next, actor, note) {
    const initial = await query('SELECT order_id FROM seller_orders WHERE id=?').get(sellerOrderId);
    if (!initial) throw new HttpError(404, 'Seller order not found');
    // Parent-first locking serializes transitions across all seller sub-orders of one order.
    const parent = await query('SELECT * FROM orders WHERE id=? FOR UPDATE').get(initial.order_id);
    if (!parent) throw new HttpError(404, 'Order not found');
    const sellerOrder = await query('SELECT * FROM seller_orders WHERE id=? AND order_id=? FOR UPDATE')
      .get(sellerOrderId, initial.order_id);
    if (!sellerOrder) throw new HttpError(404, 'Seller order not found');
    if (!(POSTGRES_ORDER_TRANSITIONS[sellerOrder.status] || []).includes(next)) throw conflict();

    if (next === 'CANCELLED') {
      const items = await query('SELECT product_id,quantity FROM order_items WHERE seller_order_id=? ORDER BY product_id')
        .all(sellerOrder.id);
      for (const item of items) {
        const quantity = Number(item.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Invalid order item quantity');
        await query('UPDATE products SET stock=stock+? WHERE id=?').run(quantity, item.product_id);
      }
      const others = await query("SELECT COUNT(*) count FROM seller_orders WHERE order_id=? AND id<>? AND status<>'CANCELLED'")
        .get(parent.id, sellerOrder.id);
      if (parent.payment_status === 'PAID' && parent.payment_method !== 'COD' && Number(others.count) > 0) {
        const total = safeAmount(parent.total_paisa);
        const cap = Math.min(safeAmount(sellerOrder.subtotal_paisa), total);
        await ensureRefund(parent.id, cap, 'বিক্রেতা অর্ডার বাতিল');
      }
    }

    await query('UPDATE seller_orders SET status=? WHERE id=?').run(next, sellerOrder.id);
    if (next === 'DELIVERED') {
      await query("INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .run(generateId(), 'SELLER_EARNING', parent.id, sellerOrder.id, sellerOrder.seller_id,
          safeAmount(sellerOrder.net_paisa), sellerOrder.id, getNow());
      await query("INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .run(generateId(), 'COMMISSION', parent.id, sellerOrder.id, sellerOrder.seller_id,
          safeAmount(sellerOrder.commission_paisa), sellerOrder.id, getNow());
    }

    await addEvent(parent.id, sellerOrder.id, next, note, actor);
    await audit(actor, 'ORDER_STATUS_' + next, 'seller_order', sellerOrder.id, { from: sellerOrder.status, order_id: parent.id });
    await notify(parent.user_id, 'অর্ডার ' + orderNo(parent.id), 'স্ট্যাটাস: ' + next);
    return recomputeParent(parent.id);
  }

  async function applySellerStatus(sellerOrderId, next, actor, note = '') {
    return database.tx(() => applySellerStatusInTransaction(sellerOrderId, next, actor, note));
  }

  async function applyParentStatus(orderId, next, actor, note = '', { onlyIfAllCancellable = false } = {}) {
    return database.tx(async () => {
      const parent = await query('SELECT * FROM orders WHERE id=? FOR UPDATE').get(orderId);
      if (!parent) throw new HttpError(404, 'Order not found');
      if (!(POSTGRES_ORDER_TRANSITIONS[parent.status] || []).includes(next)) throw conflict();
      const subOrders = await query('SELECT id,status FROM seller_orders WHERE order_id=? ORDER BY id FOR UPDATE').all(orderId);
      if (onlyIfAllCancellable && subOrders.some(row => !['CONFIRMED', 'AWAITING_PAYMENT'].includes(row.status))) {
        throw conflict();
      }
      let moved = 0;
      for (const sellerOrder of subOrders) {
        if ((POSTGRES_ORDER_TRANSITIONS[sellerOrder.status] || []).includes(next)) {
          await applySellerStatusInTransaction(sellerOrder.id, next, actor, note);
          moved++;
        }
      }
      if (!subOrders.length) {
        if (next === 'CANCELLED') {
          const items = await query('SELECT product_id,quantity FROM order_items WHERE order_id=? ORDER BY product_id').all(orderId);
          for (const item of items) await query('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity, item.product_id);
          if (parent.payment_status === 'PAID') await ensureRefund(orderId, safeAmount(parent.total_paisa), 'অর্ডার বাতিল');
        }
        await query('UPDATE orders SET status=? WHERE id=?').run(next, orderId);
        await addEvent(orderId, null, next, note, actor);
        moved++;
      }
      if (!moved) throw conflict();
      await audit(actor, 'ORDER_PARENT_' + next, 'order', orderId, { note });
      return (await query('SELECT status FROM orders WHERE id=?').get(orderId)).status;
    });
  }

  return Object.freeze({ applySellerStatus, applyParentStatus, recomputeParent });
}
