import { randomUUID } from 'node:crypto';

const SELLER_TRANSITIONS = {
  AWAITING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED']
};
const PARENT_TRANSITIONS = {
  AWAITING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED']
};
const ONLINE_METHODS = new Set(['BKASH', 'NAGAD', 'ROCKET', 'SSLCOMMERZ']);

function safeInteger(value, label) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new TypeError(label + ' must be a safe integer');
  return n;
}
function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
function required(value, label, max = 200) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new TypeError(label + ' is required and must be at most ' + max + ' characters');
  return result;
}
function orderNumber(id) {
  return 'BD-' + String(id).slice(0, 8).toUpperCase();
}

export function createPostgresOrdersPaymentsRepository(database, {
  createId = randomUUID,
  clock = () => new Date().toISOString()
} = {}) {
  if (!database || typeof database.q !== 'function' || typeof database.tx !== 'function') {
    throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  }
  const query = sql => database.q(sql);

  async function listCustomerOrders(userId, { limit = 50, beforeCreatedAt, beforeId } = {}) {
    const size = Math.min(Math.max(safeInteger(limit, 'limit'), 1), 100);
    const cursor = beforeCreatedAt && beforeId ? ' AND (created_at,id)<(?,?)' : '';
    const args = [String(userId)];
    if (cursor) args.push(String(beforeCreatedAt), String(beforeId));
    args.push(size);
    const rows = await query('SELECT id,total_paisa,subtotal_paisa,shipping_paisa,discount_paisa,status,payment_method,payment_status,created_at FROM orders WHERE user_id=?' + cursor + ' ORDER BY created_at DESC,id DESC LIMIT ?').all(...args);
    return rows.map(row => ({
      id: row.id, orderNumber: orderNumber(row.id),
      total_paisa: safeInteger(row.total_paisa, 'total_paisa'),
      subtotal_paisa: safeInteger(row.subtotal_paisa, 'subtotal_paisa'),
      shipping_paisa: safeInteger(row.shipping_paisa, 'shipping_paisa'),
      discount_paisa: safeInteger(row.discount_paisa, 'discount_paisa'),
      status: row.status, payment: { method: row.payment_method, status: row.payment_status }, created_at: row.created_at
    }));
  }

  async function getCustomerOrder(userId, orderId) {
    const order = await query('SELECT * FROM orders WHERE id=? AND user_id=?').get(String(orderId), String(userId));
    if (!order) return null;
    const [items, sellerOrders, events] = await Promise.all([
      query('SELECT product_id,product_name_bn,quantity,unit_price_paisa,variant,seller_order_id FROM order_items WHERE order_id=? ORDER BY id').all(order.id),
      query('SELECT so.id,so.status,so.subtotal_paisa,sp.shop_name FROM seller_orders so LEFT JOIN seller_profiles sp ON sp.user_id=so.seller_id WHERE so.order_id=? ORDER BY so.id').all(order.id),
      query('SELECT status,note,created_at,seller_order_id FROM order_events WHERE order_id=? ORDER BY created_at,id').all(order.id)
    ]);
    return {
      id: order.id, orderNumber: orderNumber(order.id),
      total_paisa: safeInteger(order.total_paisa, 'total_paisa'),
      subtotal_paisa: safeInteger(order.subtotal_paisa, 'subtotal_paisa'),
      shipping_paisa: safeInteger(order.shipping_paisa, 'shipping_paisa'),
      discount_paisa: safeInteger(order.discount_paisa, 'discount_paisa'),
      coupon_code: order.coupon_code, status: order.status,
      payment: { method: order.payment_method, status: order.payment_status }, created_at: order.created_at,
      delivery: { name: order.delivery_name, phone: order.delivery_phone, address: order.delivery_address, area: order.delivery_area, note: order.customer_note },
      items: items.map(item => ({
        product_id: item.product_id, name_bn: item.product_name_bn,
        quantity: safeInteger(item.quantity, 'quantity'),
        unit_price_paisa: safeInteger(item.unit_price_paisa, 'unit_price_paisa'), variant: item.variant
      })),
      seller_orders: sellerOrders, events
    };
  }

  async function getTracking(userId, orderId) {
    const order = await query('SELECT id,status FROM orders WHERE id=? AND user_id=?').get(String(orderId), String(userId));
    if (!order) return null;
    const [events, shipments] = await Promise.all([
      query('SELECT status,note,created_at,seller_order_id FROM order_events WHERE order_id=? ORDER BY created_at,id').all(order.id),
      query('SELECT s.provider,s.tracking_id,s.status,s.created_at FROM shipments s JOIN seller_orders so ON so.id=s.seller_order_id WHERE so.order_id=? ORDER BY s.created_at DESC').all(order.id)
    ]);
    return { orderNumber: orderNumber(order.id), status: order.status, events, shipments };
  }

  async function setPaymentInitiated({ userId, paymentId, gatewayTxnId, raw = {} } = {}) {
    const pid = required(paymentId, 'paymentId', 160);
    const txn = required(gatewayTxnId, 'gatewayTxnId', 200);
    return database.tx(async () => {
      const payment = await query('SELECT p.*,o.user_id,o.status order_status,o.payment_status FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=? AND o.user_id=? FOR UPDATE OF p,o')
        .get(pid, String(userId));
      if (!payment) throw fail(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
      if (!ONLINE_METHODS.has(payment.method)) throw fail(409, 'INVALID_PAYMENT_METHOD', 'Only online payments can be initiated');
      if (payment.status !== 'PENDING' || payment.order_status !== 'AWAITING_PAYMENT' || payment.payment_status === 'PAID') {
        throw fail(409, 'PAYMENT_NOT_PENDING', 'This payment is no longer pending');
      }
      const stamp = clock();
      const updated = await query("UPDATE payments SET status='INITIATED',gateway_txn_id=?,raw=?,updated_at=? WHERE id=? AND status='PENDING' RETURNING id,status")
        .get(txn, JSON.stringify(raw), stamp, pid);
      if (!updated) throw fail(409, 'PAYMENT_STATE_CHANGED', 'Payment state changed; try again');
      return { id: pid, status: 'INITIATED', gateway_txn_id: txn };
    });
  }

  async function recordVerifiedPaymentCallback({ method, gatewayTxnId, amountPaisa, status } = {}) {
    const paymentMethod = String(method || '').toUpperCase();
    const transactionId = required(gatewayTxnId, 'gatewayTxnId', 200);
    const amount = safeInteger(amountPaisa, 'amountPaisa');
    const outcome = String(status || '').toUpperCase();
    if (!ONLINE_METHODS.has(paymentMethod) || amount <= 0 || !['SUCCESS', 'FAILED'].includes(outcome)) {
      throw fail(400, 'INVALID_CALLBACK', 'Invalid verified payment callback');
    }
    return database.tx(async () => {
      const payment = await query('SELECT p.*,o.user_id,o.status order_status,o.payment_status,o.total_paisa FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.method=? AND p.gateway_txn_id=? FOR UPDATE OF p,o')
        .get(paymentMethod, transactionId);
      if (!payment) throw fail(404, 'PAYMENT_NOT_FOUND', 'Unknown gateway transaction');
      if (safeInteger(payment.amount_paisa, 'payment amount') !== amount || safeInteger(payment.total_paisa, 'order total') !== amount) {
        throw fail(400, 'AMOUNT_MISMATCH', 'Payment amount does not match the order total');
      }
      if (payment.status === 'PAID' || payment.status === 'REFUNDED') return { duplicate: true, status: payment.status };
      if (payment.status === 'SUPERSEDED') return { duplicate: true, status: payment.status };
      if (outcome === 'FAILED') {
        if (payment.status === 'FAILED') return { duplicate: true, status: 'FAILED' };
        if (payment.status !== 'INITIATED') throw fail(409, 'PAYMENT_NOT_INITIATED', 'Payment was not initiated');
        const stamp = clock();
        await query("UPDATE payments SET status='FAILED',updated_at=? WHERE id=?").run(stamp, payment.id);
        await query('INSERT INTO order_events(id,order_id,seller_order_id,status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), payment.order_id, null, 'PAYMENT_FAILED', paymentMethod, null, stamp);
        await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), null, 'PAYMENT_FAILED', 'payment', payment.id, JSON.stringify({ method: paymentMethod }), stamp);
        await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
          .run(randomUUID(), payment.user_id, 'পেমেন্ট ব্যর্থ', orderNumber(payment.order_id) + ' — আবার চেষ্টা করুন', stamp);
        return { duplicate: false, status: 'FAILED' };
      }
      if (payment.status !== 'INITIATED') throw fail(409, 'PAYMENT_NOT_INITIATED', 'Payment was not initiated');
      const stamp = clock();
      await query("UPDATE payments SET status='PAID',updated_at=? WHERE id=?").run(stamp, payment.id);
      await query("UPDATE orders SET payment_status='PAID' WHERE id=?").run(payment.order_id);
      await query('INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,ref) DO NOTHING')
        .run(randomUUID(), 'ORDER_PAYMENT', payment.order_id, null, null, amount, payment.id, stamp);
      if (payment.order_status === 'AWAITING_PAYMENT') {
        await query("UPDATE seller_orders SET status='CONFIRMED' WHERE order_id=? AND status='AWAITING_PAYMENT'").run(payment.order_id);
        await query("UPDATE orders SET status='CONFIRMED' WHERE id=? AND status='AWAITING_PAYMENT'").run(payment.order_id);
        await query('INSERT INTO order_events(id,order_id,seller_order_id,status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), payment.order_id, null, 'PAYMENT_CONFIRMED', paymentMethod, null, stamp);
        const sellers = await query('SELECT seller_id FROM seller_orders WHERE order_id=?').all(payment.order_id);
        for (const seller of sellers) {
          await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
            .run(randomUUID(), seller.seller_id, 'নতুন অর্ডার', orderNumber(payment.order_id), stamp);
        }
      } else if (payment.order_status === 'CANCELLED') {
        await query('INSERT INTO refunds(id,order_id,amount_paisa,reason,status,created_at,decided_at) VALUES(?,?,?,?,?,?,NULL)')
          .run(randomUUID(), payment.order_id, amount, 'বাতিল অর্ডারে পেমেন্ট এসেছে (বাতিল)', 'REQUESTED', stamp);
      }
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), null, 'PAYMENT_PAID', 'payment', payment.id, JSON.stringify({ method: paymentMethod, amount_paisa: amount }), stamp);
      await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
        .run(randomUUID(), payment.user_id, 'পেমেন্ট সফল', orderNumber(payment.order_id), stamp);
      return { duplicate: false, status: 'PAID' };
    });
  }

  async function requestAdditionalRefund(orderId, requestedAmount, cap, reason) {
    const rows = await query("SELECT COALESCE(SUM(amount_paisa),0) total FROM refunds WHERE order_id=? AND status<>'REJECTED'").get(orderId);
    const already = safeInteger(rows?.total ?? 0, 'refund total');
    const amount = Math.min(safeInteger(requestedAmount, 'refund amount'), safeInteger(cap, 'refund cap') - already);
    if (amount <= 0) return null;
    const refundId = randomUUID();
    await query('INSERT INTO refunds(id,order_id,amount_paisa,reason,status,created_at,decided_at) VALUES(?,?,?,?,?,?,NULL)')
      .run(refundId, orderId, amount, reason, 'REQUESTED', clock());
    return refundId;
  }

  async function recomputeParent(orderId) {
    const subs = await query('SELECT id,status,subtotal_paisa,seller_id,commission_paisa,net_paisa FROM seller_orders WHERE order_id=? ORDER BY id').all(orderId);
    if (!subs.length) return null;
    const states = subs.map(item => item.status);
    let next = 'CONFIRMED';
    if (states.every(state => state === 'CANCELLED')) next = 'CANCELLED';
    else if (states.every(state => ['DELIVERED', 'CANCELLED'].includes(state))) next = 'DELIVERED';
    else if (states.some(state => ['SHIPPED', 'DELIVERED'].includes(state))) next = 'SHIPPED';
    else if (states.some(state => state === 'PROCESSING')) next = 'PROCESSING';
    else if (states.every(state => ['AWAITING_PAYMENT', 'CANCELLED'].includes(state))) next = 'AWAITING_PAYMENT';
    await query('UPDATE orders SET status=? WHERE id=?').run(next, orderId);
    const order = await query('SELECT payment_method,payment_status,total_paisa,user_id FROM orders WHERE id=?').get(orderId);
    if (next === 'DELIVERED' && order.payment_method === 'COD' && order.payment_status !== 'PAID') {
      const stamp = clock();
      await query("UPDATE orders SET payment_status='PAID' WHERE id=?").run(orderId);
      await query("UPDATE payments SET status='PAID',updated_at=? WHERE order_id=? AND method='COD'").run(stamp, orderId);
      await query('INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,ref) DO NOTHING')
        .run(randomUUID(), 'ORDER_PAYMENT', orderId, null, null, safeInteger(order.total_paisa, 'total_paisa'), 'cod:' + orderId, stamp);
    }
    if (next === 'CANCELLED' && order.payment_status === 'PAID') {
      await requestAdditionalRefund(orderId, safeInteger(order.total_paisa, 'total_paisa'), safeInteger(order.total_paisa, 'total_paisa'), 'অর্ডার বাতিল');
    }
    return next;
  }

  async function transitionSellerInsideTransaction({ sellerOrder, nextStatus, actorId, note }) {
    const from = sellerOrder.status;
    if (!(SELLER_TRANSITIONS[from] || []).includes(nextStatus)) {
      throw fail(409, 'INVALID_ORDER_TRANSITION', 'Order cannot move from ' + from + ' to ' + nextStatus);
    }
    const stamp = clock();
    if (nextStatus === 'CANCELLED') {
      const items = await query('SELECT product_id,quantity FROM order_items WHERE seller_order_id=? ORDER BY product_id FOR UPDATE').all(sellerOrder.id);
      for (const item of items) {
        const product = await query('SELECT stock FROM products WHERE id=? FOR UPDATE').get(item.product_id);
        if (!product) throw fail(409, 'PRODUCT_MISSING', 'Cannot restore stock for a missing product');
        const before = safeInteger(product.stock, 'stock');
        const quantity = safeInteger(item.quantity, 'quantity');
        const after = safeInteger(before + quantity, 'restored stock');
        if (after > 2147483647) throw fail(409, 'STOCK_LIMIT', 'Restored stock exceeds the supported range');
        await query('UPDATE products SET stock=?,updated_at=? WHERE id=?').run(after, stamp, item.product_id);
        await query('INSERT INTO inventory_movements(id,product_id,delta,stock_before,stock_after,reason,actor_id,reference,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), item.product_id, quantity, before, after, 'SELLER_ORDER_CANCELLED', actorId || null, sellerOrder.id, stamp);
      }
    }

    await query('UPDATE seller_orders SET status=? WHERE id=?').run(nextStatus, sellerOrder.id);
    if (nextStatus === 'DELIVERED') {
      await query('INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,ref) DO NOTHING')
        .run(randomUUID(), 'SELLER_EARNING', sellerOrder.order_id, sellerOrder.id, sellerOrder.seller_id, sellerOrder.net_paisa, sellerOrder.id + ':earning', stamp);
      await query('INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,ref) DO NOTHING')
        .run(randomUUID(), 'COMMISSION', sellerOrder.order_id, sellerOrder.id, sellerOrder.seller_id, sellerOrder.commission_paisa, sellerOrder.id + ':commission', stamp);
    }
    await query('INSERT INTO order_events(id,order_id,seller_order_id,status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), sellerOrder.order_id, sellerOrder.id, nextStatus, String(note || '').slice(0, 300), actorId || null, stamp);
    await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), actorId || null, 'SELLER_ORDER_' + nextStatus, 'seller_order', sellerOrder.id,
        JSON.stringify({ from, order_id: sellerOrder.order_id }), stamp);
    const owner = await query('SELECT user_id FROM orders WHERE id=?').get(sellerOrder.order_id);
    if (owner) await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
      .run(randomUUID(), owner.user_id, 'অর্ডার ' + orderNumber(sellerOrder.order_id), 'স্ট্যাটাস: ' + nextStatus, stamp);
    const parentStatus = await recomputeParent(sellerOrder.order_id);
    if (nextStatus === 'CANCELLED') {
      const order = await query('SELECT payment_status,total_paisa FROM orders WHERE id=?').get(sellerOrder.order_id);
      if (order?.payment_status === 'PAID') {
        const others = await query("SELECT COUNT(*) count FROM seller_orders WHERE order_id=? AND status<>'CANCELLED'").get(sellerOrder.order_id);
        if (safeInteger(others.count, 'remaining seller orders') > 0) {
          await requestAdditionalRefund(sellerOrder.order_id, safeInteger(sellerOrder.subtotal_paisa, 'subtotal_paisa'),
            safeInteger(order.total_paisa, 'total_paisa'), 'বিক্রেতা অর্ডার বাতিল');
        }
      }
    }
    return { id: sellerOrder.id, status: nextStatus, parent_status: parentStatus };
  }

  async function transitionSellerOrder({ sellerId, sellerOrderId, nextStatus, actorId = sellerId, note = '' } = {}) {
    const next = String(nextStatus || '').toUpperCase();
    return database.tx(async () => {
      const sellerOrder = await query('SELECT * FROM seller_orders WHERE id=? AND seller_id=? FOR UPDATE').get(String(sellerOrderId), String(sellerId));
      if (!sellerOrder) throw fail(404, 'SELLER_ORDER_NOT_FOUND', 'Seller order not found');
      return transitionSellerInsideTransaction({ sellerOrder, nextStatus: next, actorId, note });
    });
  }

  async function transitionParentOrder({ orderId, nextStatus, actorId, note = '' } = {}) {
    const next = String(nextStatus || '').toUpperCase();
    return database.tx(async () => {
      const order = await query('SELECT id,status FROM orders WHERE id=? FOR UPDATE').get(String(orderId));
      if (!order) throw fail(404, 'ORDER_NOT_FOUND', 'Order not found');
      if (!(PARENT_TRANSITIONS[order.status] || []).includes(next)) {
        throw fail(409, 'INVALID_ORDER_TRANSITION', 'Order cannot move from ' + order.status + ' to ' + next);
      }
      const sellerOrders = await query('SELECT * FROM seller_orders WHERE order_id=? ORDER BY id FOR UPDATE').all(order.id);
      if (!sellerOrders.length) throw fail(409, 'LEGACY_ORDER_UNSUPPORTED', 'This order has no seller sub-orders');
      let moved = 0;
      for (const sellerOrder of sellerOrders) {
        if ((SELLER_TRANSITIONS[sellerOrder.status] || []).includes(next)) {
          await transitionSellerInsideTransaction({ sellerOrder, nextStatus: next, actorId, note });
          moved += 1;
        } else if (sellerOrder.status !== 'CANCELLED' && sellerOrder.status !== next) {
          throw fail(409, 'INVALID_ORDER_TRANSITION', 'At least one seller order cannot move to ' + next);
        }
      }
      if (!moved) throw fail(409, 'INVALID_ORDER_TRANSITION', 'No seller order could be updated');
      const final = await query('SELECT status FROM orders WHERE id=?').get(order.id);
      return { id: order.id, status: final.status };
    });
  }


  async function prepareCustomerPayment({ userId, orderId, method } = {}) {
    const uid = required(userId, 'userId', 160);
    const oid = required(orderId, 'orderId', 160);
    const paymentMethod = String(method || '').toUpperCase();
    if (!ONLINE_METHODS.has(paymentMethod)) throw fail(400, 'INVALID_PAYMENT_METHOD', 'Unsupported online payment method');
    return database.tx(async () => {
      const order = await query('SELECT id,status,payment_status,total_paisa,payment_method FROM orders WHERE id=? AND user_id=? FOR UPDATE').get(oid, uid);
      if (!order) throw fail(404, 'ORDER_NOT_FOUND', 'Order not found');
      if (order.status !== 'AWAITING_PAYMENT' || order.payment_status === 'PAID') {
        throw fail(409, 'PAYMENT_NOT_REQUIRED', 'This order does not need another payment');
      }
      const pending = await query("SELECT * FROM payments WHERE order_id=? AND status IN ('PENDING','INITIATED') ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE").get(oid);
      if (pending?.status === 'INITIATED') {
        throw fail(409, 'PAYMENT_ATTEMPT_ACTIVE', 'An online payment attempt is already active');
      }
      if (pending?.status === 'PENDING' && pending.method === paymentMethod) return {
        id: pending.id, order_id: oid, method: pending.method,
        amount_paisa: safeInteger(pending.amount_paisa, 'amount_paisa'), status: pending.status
      };
      if (pending?.status === 'PENDING') {
        await query("UPDATE payments SET status='SUPERSEDED',updated_at=? WHERE id=? AND status='PENDING' AND gateway_txn_id IS NULL")
          .run(clock(), pending.id);
      }
      const id = createId();
      const stamp = clock();
      await query('INSERT INTO payments(id,order_id,method,amount_paisa,status,gateway_txn_id,raw,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, oid, paymentMethod, safeInteger(order.total_paisa, 'total_paisa'), 'PENDING', null, '{}', stamp, stamp);
      await query('UPDATE orders SET payment_method=? WHERE id=?').run(paymentMethod, oid);
      return { id, order_id: oid, method: paymentMethod, amount_paisa: safeInteger(order.total_paisa, 'total_paisa'), status: 'PENDING' };
    });
  }

  async function getCustomerPayment(userId, paymentId) {
    const payment = await query('SELECT p.id,p.order_id,p.method,p.amount_paisa,p.status,p.gateway_txn_id,p.raw,p.created_at,p.updated_at FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=? AND o.user_id=?')
      .get(String(paymentId), String(userId));
    if (!payment) return null;
    return { ...payment, amount_paisa: safeInteger(payment.amount_paisa, 'amount_paisa') };
  }

  async function listSellerOrders(sellerId, { status, limit = 100 } = {}) {
    const size = Math.min(Math.max(safeInteger(limit, 'limit'), 1), 200);
    const allowed = ['AWAITING_PAYMENT','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED'];
    const filtered = status && allowed.includes(String(status).toUpperCase()) ? ' AND so.status=?' : '';
    const args = [String(sellerId)];
    if (filtered) args.push(String(status).toUpperCase());
    args.push(size);
    const sql = "SELECT so.id,so.order_id,so.status,so.subtotal_paisa,so.commission_paisa,so.net_paisa,so.created_at," +
      "o.delivery_name,o.delivery_phone,o.delivery_address,o.delivery_area,o.customer_note,o.payment_method,o.payment_status," +
      "u.name customer_name,u.phone customer_phone,sp.shop_name FROM seller_orders so " +
      "JOIN orders o ON o.id=so.order_id JOIN users u ON u.id=o.user_id " +
      "LEFT JOIN seller_profiles sp ON sp.user_id=so.seller_id " +
      "WHERE so.seller_id=? AND so.status<>'AWAITING_PAYMENT'" + filtered + " ORDER BY so.created_at DESC,so.id DESC LIMIT ?";
    const rows = await query(sql).all(...args);
    return Promise.all(rows.map(async row => ({
      ...row,
      subtotal_paisa: safeInteger(row.subtotal_paisa, 'subtotal_paisa'),
      commission_paisa: safeInteger(row.commission_paisa, 'commission_paisa'),
      net_paisa: safeInteger(row.net_paisa, 'net_paisa'),
      items: (await query('SELECT product_name_bn,quantity,unit_price_paisa,variant FROM order_items WHERE seller_order_id=? ORDER BY id').all(row.id)).map(item => ({
        ...item, quantity: safeInteger(item.quantity, 'quantity'), unit_price_paisa: safeInteger(item.unit_price_paisa, 'unit_price_paisa')
      }))
    })));
  }

  async function getSellerOrder(sellerId, sellerOrderId) {
    const order = await query(`SELECT so.*,o.delivery_name,o.delivery_phone,o.delivery_address,o.delivery_area,o.customer_note,o.payment_method,o.payment_status,
      u.name customer_name,u.phone customer_phone
      FROM seller_orders so JOIN orders o ON o.id=so.order_id JOIN users u ON u.id=o.user_id
      WHERE so.id=? AND so.seller_id=?`).get(String(sellerOrderId), String(sellerId));
    if (!order) return null;
    const [items, events, shipments] = await Promise.all([
      query('SELECT product_name_bn,quantity,unit_price_paisa,variant FROM order_items WHERE seller_order_id=? ORDER BY id').all(order.id),
      query('SELECT status,note,created_at FROM order_events WHERE seller_order_id=? ORDER BY created_at,id').all(order.id),
      query('SELECT id,provider,tracking_id,status FROM shipments WHERE seller_order_id=? ORDER BY created_at DESC LIMIT 1').all(order.id)
    ]);
    return {
      ...order,
      subtotal_paisa: safeInteger(order.subtotal_paisa, 'subtotal_paisa'),
      commission_paisa: safeInteger(order.commission_paisa, 'commission_paisa'),
      net_paisa: safeInteger(order.net_paisa, 'net_paisa'),
      items: items.map(item => ({ ...item, quantity: safeInteger(item.quantity, 'quantity'), unit_price_paisa: safeInteger(item.unit_price_paisa, 'unit_price_paisa') })),
      events, shipment: shipments[0] || null
    };
  }

  async function listAdminOrders({ status, query: search, limit = 100 } = {}) {
    const size = Math.min(Math.max(safeInteger(limit, 'limit'), 1), 200);
    const clauses = [];
    const args = [];
    const allowed = ['AWAITING_PAYMENT','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED'];
    if (status && allowed.includes(String(status).toUpperCase())) { clauses.push('o.status=?'); args.push(String(status).toUpperCase()); }
    if (search) {
      clauses.push('(o.id LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)');
      const term = '%' + String(search).slice(0, 80) + '%';
      args.push(term, term, term);
    }
    args.push(size);
    return query(`SELECT o.id,o.user_id,o.total_paisa,o.subtotal_paisa,o.shipping_paisa,o.discount_paisa,o.status,
      o.payment_method,o.payment_status,o.created_at,o.delivery_name,o.delivery_phone,u.name customer_name,u.phone customer_phone
      FROM orders o JOIN users u ON u.id=o.user_id${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}
      ORDER BY o.created_at DESC,o.id DESC LIMIT ?`).all(...args);
  }

  async function getAdminOrder(orderId) {
    const order = await query('SELECT o.*,u.name customer_name,u.phone customer_phone,u.email customer_email FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?').get(String(orderId));
    if (!order) return null;
    const [items, sellerOrders, events, payments] = await Promise.all([
      query('SELECT product_id,product_name_bn,quantity,unit_price_paisa,variant,seller_order_id FROM order_items WHERE order_id=? ORDER BY id').all(order.id),
      query('SELECT so.id,so.seller_id,so.status,so.subtotal_paisa,so.commission_paisa,so.net_paisa,sp.shop_name FROM seller_orders so LEFT JOIN seller_profiles sp ON sp.user_id=so.seller_id WHERE so.order_id=? ORDER BY so.id').all(order.id),
      query('SELECT status,note,created_at,seller_order_id,actor_id FROM order_events WHERE order_id=? ORDER BY created_at,id').all(order.id),
      query('SELECT id,method,amount_paisa,status,gateway_txn_id,created_at FROM payments WHERE order_id=? ORDER BY created_at,id').all(order.id)
    ]);
    return {
      ...order,
      total_paisa: safeInteger(order.total_paisa, 'total_paisa'),
      items: items.map(item => ({ ...item, quantity: safeInteger(item.quantity, 'quantity'), unit_price_paisa: safeInteger(item.unit_price_paisa, 'unit_price_paisa') })),
      seller_orders: sellerOrders, events,
      payments: payments.map(payment => ({ ...payment, amount_paisa: safeInteger(payment.amount_paisa, 'amount_paisa') }))
    };
  }

  async function cancelCustomerOrder({ userId, orderId, actorId = userId, note = '' } = {}) {
    return database.tx(async () => {
      const owned = await query('SELECT id FROM orders WHERE id=? AND user_id=? FOR UPDATE').get(
        required(orderId, 'orderId', 160), required(userId, 'userId', 160)
      );
      if (!owned) throw fail(404, 'ORDER_NOT_FOUND', 'Order not found');
      return transitionParentOrder({ orderId: owned.id, nextStatus: 'CANCELLED', actorId, note });
    });
  }

  return Object.freeze({
    listCustomerOrders, getCustomerOrder, getTracking, getCustomerPayment, cancelCustomerOrder,
    prepareCustomerPayment, listSellerOrders, getSellerOrder, listAdminOrders, getAdminOrder,
    setPaymentInitiated, recordVerifiedPaymentCallback,
    transitionSellerOrder, transitionParentOrder
  });
}
