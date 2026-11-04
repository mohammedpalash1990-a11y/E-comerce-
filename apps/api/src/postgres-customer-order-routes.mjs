import { HttpError } from './postgres-shared.mjs';

const bdt = value => Number(value || 0) / 100;
const orderNumber = value => 'HAAT-' + String(value).replace(/-/g, '').slice(0, 10).toUpperCase();
const shipmentView = row => ({
  provider: row.provider, tracking_id: row.tracking_id, status: row.shipment_status,
  mode: row.mode
});

// Read-only customer projections. Never reuse the admin projection: it contains
// internal notes, actor IDs, seller commissions and payment-provider references.
export function registerPostgresCustomerOrderRoutes(route, ok, { database } = {}) {
  if (!database?.q || !database?.tx) throw new TypeError('PostgreSQL database with transactions is required');
  const q = sql => database.q(sql);
  const readOwnedOrder = (orderId, userId, project) => database.tx(async () => {
    // All fragments must describe the same snapshot, even during fulfilment.
    await q('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY').run();
    const order = await q(`SELECT id,total_paisa,subtotal_paisa,shipping_paisa,discount_paisa,
      coupon_code,status,payment_method,payment_status,created_at,
      delivery_name,delivery_phone,delivery_address,delivery_area,customer_note
      FROM orders WHERE id=? AND user_id=?`).get(orderId, userId);
    // Do not read child rows before ownership is established. Missing and foreign
    // orders intentionally share the same response to prevent enumeration.
    if (!order) throw new HttpError(404, 'Order not found');
    return project(order);
  });

  route('GET', '/api/v1/customer/orders/:id', ['CUSTOMER'], async ({ user, params }) =>
    readOwnedOrder(params[0], user.id, async order => {
      const items = await q(`SELECT product_id,product_name_bn,quantity,unit_price_paisa,variant,seller_order_id
        FROM order_items WHERE order_id=? ORDER BY id`).all(order.id);
      const suborders = await q(`SELECT so.id,so.status,so.subtotal_paisa,sp.shop_name,
          s.provider,s.tracking_id,s.status AS shipment_status,s.mode
        FROM seller_orders so LEFT JOIN seller_profiles sp ON sp.user_id=so.seller_id
        LEFT JOIN LATERAL (
          SELECT provider,tracking_id,status,mode FROM shipments
          WHERE seller_order_id=so.id ORDER BY created_at DESC,id DESC LIMIT 1
        ) s ON TRUE
        WHERE so.order_id=? ORDER BY so.created_at,so.id`).all(order.id);
      return ok({
        id: order.id, orderNumber: orderNumber(order.id), status: order.status,
        total_bdt: bdt(order.total_paisa), subtotal_bdt: bdt(order.subtotal_paisa),
        shipping_bdt: bdt(order.shipping_paisa), discount_bdt: bdt(order.discount_paisa),
        coupon_code: order.coupon_code, created_at: order.created_at,
        payment: { method: order.payment_method, status: order.payment_status },
        delivery: { name: order.delivery_name, phone: order.delivery_phone,
          address: order.delivery_address, area: order.delivery_area, note: order.customer_note },
        items: items.map(item => ({ product_id: item.product_id, name_bn: item.product_name_bn,
          quantity: Number(item.quantity), unit_price_bdt: bdt(item.unit_price_paisa),
          variant: item.variant, seller_order_id: item.seller_order_id })),
        suborders: suborders.map(suborder => ({ id: suborder.id, shop: suborder.shop_name,
          status: suborder.status, subtotal_bdt: bdt(suborder.subtotal_paisa),
          shipment: suborder.tracking_id == null ? null : shipmentView(suborder) }))
      });
    }));

  route('GET', '/api/v1/customer/orders/:id/tracking', ['CUSTOMER'], async ({ user, params }) =>
    readOwnedOrder(params[0], user.id, async order => {
      // Free-text operational notes are not a customer-visible timeline. A future
      // public-message field must have its own explicit publication policy.
      const events = await q(`SELECT status,created_at,seller_order_id FROM order_events
        WHERE order_id=? ORDER BY created_at,id`).all(order.id);
      const shipments = await q(`SELECT s.seller_order_id,s.provider,s.tracking_id,s.status AS shipment_status,s.mode
        FROM shipments s JOIN seller_orders so ON so.id=s.seller_order_id
        WHERE so.order_id=? ORDER BY s.created_at,s.id`).all(order.id);
      return ok({ orderNumber: orderNumber(order.id), status: order.status,
        events: events.map(event => ({ status: event.status, created_at: event.created_at,
          seller_order_id: event.seller_order_id })),
        shipments: shipments.map(shipment => ({ seller_order_id: shipment.seller_order_id, ...shipmentView(shipment) }))
      });
    }));
}
