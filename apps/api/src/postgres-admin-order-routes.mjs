import { id, now, HttpError, text } from './postgres-shared.mjs';

const bdt = value => Number(value || 0) / 100;
const toPaisa = value => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new HttpError(400, 'ডেলিভারি চার্জ সঠিক নয়');
  const paisa = Math.round(amount * 100);
  if (!Number.isSafeInteger(paisa)) throw new HttpError(400, 'ডেলিভারি চার্জ সঠিক নয়');
  return paisa;
};
const orderNo = value => 'HAAT-' + String(value).replace(/-/g, '').slice(0, 10).toUpperCase();

export function registerPostgresAdminOrderRoutes(route, ok, { database, id: generateId = id, now: getNow = now } = {}) {
  if (!database?.q || !database?.tx) throw new TypeError('PostgreSQL database with transactions is required');
  const q = sql => database.q(sql);

  route('GET', '/api/v1/admin/orders/:id', ['ADMIN'], async ({ params }) => {
    const order = await q(`SELECT o.id,o.user_id,o.total_paisa,o.subtotal_paisa,o.shipping_paisa,o.discount_paisa,
      o.status,o.created_at,o.delivery_name,o.delivery_phone,o.delivery_address,o.delivery_area,
      o.customer_note,o.admin_note,o.payment_method,o.payment_status,o.coupon_code,
      u.name AS customer_name,u.phone AS customer_phone,u.email AS customer_email
      FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.id=?`).get(params[0]);
    if (!order) throw new HttpError(404, 'অর্ডার পাওয়া যায়নি');
    const [items, sellers, history, payments] = await Promise.all([
      q(`SELECT id,product_id,product_name_bn,quantity,unit_price_paisa,seller_id,seller_order_id,variant
        FROM order_items WHERE order_id=? ORDER BY id`).all(order.id),
      q(`SELECT so.id,so.seller_id,so.status,so.subtotal_paisa,so.commission_paisa,so.net_paisa,
        sp.shop_name,sp.status AS seller_status
        FROM seller_orders so LEFT JOIN seller_profiles sp ON sp.user_id=so.seller_id
        WHERE so.order_id=? ORDER BY so.id`).all(order.id),
      q('SELECT status,note,created_at,seller_order_id,actor_id FROM order_events WHERE order_id=? ORDER BY created_at,id').all(order.id),
      q('SELECT id,method,amount_paisa,status,gateway_txn_id,created_at FROM payments WHERE order_id=? ORDER BY created_at,id').all(order.id)
    ]);
    return ok({
      id: order.id, orderNumber: orderNo(order.id), status: order.status,
      total_bdt: bdt(order.total_paisa), subtotal_bdt: bdt(order.subtotal_paisa),
      shipping_bdt: bdt(order.shipping_paisa), discount_bdt: bdt(order.discount_paisa),
      coupon_code: order.coupon_code, created_at: order.created_at,
      customer: { id: order.user_id, name: order.customer_name, phone: order.customer_phone, email: order.customer_email },
      delivery: { name: order.delivery_name, phone: order.delivery_phone, address: order.delivery_address, area: order.delivery_area, note: order.customer_note },
      payment: { method: order.payment_method, status: order.payment_status },
      admin_note: order.admin_note,
      items: items.map(item => ({ ...item, quantity: Number(item.quantity), unit_price_bdt: bdt(item.unit_price_paisa) })),
      sellers: sellers.map(seller => ({ ...seller, subtotal_bdt: bdt(seller.subtotal_paisa), commission_bdt: bdt(seller.commission_paisa), net_bdt: bdt(seller.net_paisa) })),
      history, payments: payments.map(payment => ({ ...payment, amount_bdt: bdt(payment.amount_paisa) }))
    });
  });

  route('POST', '/api/v1/admin/orders/:id/note', ['ADMIN'], async ({ user, params, body }) => {
    const note = text(body.note, 1000, 'নোট', { required: false });
    return database.tx(async () => {
      const order = await q('SELECT id FROM orders WHERE id=? FOR UPDATE').get(params[0]);
      if (!order) throw new HttpError(404, 'অর্ডার পাওয়া যায়নি');
      await q('UPDATE orders SET admin_note=? WHERE id=?').run(note, order.id);
      await q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(generateId(), user.id, 'ORDER_NOTE', 'order', order.id, JSON.stringify({ note }), getNow());
      return ok({ id: order.id, saved: true });
    });
  });

  route('POST', '/api/v1/admin/orders/:id/shipping', ['ADMIN'], async ({ user, params, body }) => {
    const shipping = toPaisa(body.shipping_bdt);
    return database.tx(async () => {
      const order = await q('SELECT id,subtotal_paisa,discount_paisa,shipping_paisa,payment_status,status FROM orders WHERE id=? FOR UPDATE').get(params[0]);
      if (!order) throw new HttpError(404, 'অর্ডার পাওয়া যায়নি');
      if (order.payment_status !== 'PENDING' || !['AWAITING_PAYMENT','CONFIRMED','PROCESSING'].includes(order.status)) {
        throw new HttpError(409, 'এই অর্ডারে এখন ডেলিভারি চার্জ পরিবর্তন করা যাবে না');
      }
      const total = Number(order.subtotal_paisa) + shipping - Number(order.discount_paisa || 0);
      if (!Number.isSafeInteger(total) || total < 0) throw new HttpError(409, 'ডেলিভারি চার্জের কারণে অর্ডারের মোট মূল্য সঠিক থাকছে না');
      await q('UPDATE orders SET shipping_paisa=?,total_paisa=? WHERE id=?').run(shipping,total,order.id);
      await q("UPDATE payments SET amount_paisa=?,updated_at=? WHERE order_id=? AND status IN('PENDING','INITIATED')")
        .run(total,getNow(),order.id);
      await q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(generateId(),user.id,'SHIPPING_CHARGE_SET','order',order.id,
          JSON.stringify({ from_paisa:Number(order.shipping_paisa || 0),to_paisa:shipping,total_paisa:total }),getNow());
      return ok({ id:order.id,shipping_bdt:bdt(shipping),total_bdt:bdt(total) });
    });
  });
}
