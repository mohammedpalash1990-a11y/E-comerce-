import { HttpError, text } from './postgres-shared.mjs';

const bdt = value => Number(value || 0) / 100;
const orderNumber = value => 'HAAT-' + String(value).replace(/-/g, '').slice(0, 10).toUpperCase();

export function registerPostgresSellerWorkspaceRoutes(route, ok, { database } = {}) {
  if (!database?.q) throw new TypeError('PostgreSQL database is required');
  const q = sql => database.q(sql);
  const profile = async userId => {
    const row = await q(`SELECT u.id,u.name,u.phone,sp.shop_name,sp.shop_address,sp.business_info,
      sp.status,sp.commission_bps,sp.created_at
      FROM seller_profiles sp JOIN users u ON u.id=sp.user_id WHERE sp.user_id=?`).get(userId);
    if (!row) throw new HttpError(404, 'বিক্রেতা প্রোফাইল পাওয়া যায়নি');
    return { ...row, commission_percent: Number(row.commission_bps) / 100 };
  };

  route('GET', '/api/v1/seller/profile', ['SELLER'], async ({ user }) => ok(await profile(user.id)));

  route('PATCH', '/api/v1/seller/profile', ['SELLER'], async ({ user, body }) => {
    const current = await profile(user.id);
    const shopAddress = body.shop_address !== undefined ? text(body.shop_address, 300, 'দোকানের ঠিকানা') : current.shop_address;
    const businessInfo = body.business_info !== undefined ? text(body.business_info, 1000, 'ব্যবসার বিবরণ', { required: false }) : current.business_info;
    await q('UPDATE seller_profiles SET shop_address=?,business_info=? WHERE user_id=?').run(shopAddress, businessInfo, user.id);
    return ok(await profile(user.id));
  });

  route('GET', '/api/v1/seller/reviews', ['SELLER'], async ({ user }) => {
    const rows = await q(`SELECT r.id,r.product_id,r.rating,r.comment,r.created_at,p.name_bn AS product_name_bn,u.name AS customer_name
      FROM reviews r JOIN products p ON p.id=r.product_id JOIN users u ON u.id=r.user_id
      WHERE p.seller_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 100`).all(user.id);
    return ok(rows.map(row => ({ ...row, rating: Number(row.rating) })));
  });

  route('GET', '/api/v1/seller/dashboard', ['SELLER'], async ({ user }) => {
    const p = await profile(user.id);
    const [products, orders, finance, recent] = await Promise.all([
      q(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER (WHERE status='PENDING_REVIEW')::int pending,
        COUNT(*) FILTER (WHERE status='ACTIVE' AND active=1)::int approved,
        COUNT(*) FILTER (WHERE status='REJECTED')::int rejected
        FROM products WHERE seller_id=? AND status<>'ARCHIVED'`).get(user.id),
      q(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER (WHERE status='CONFIRMED')::int confirmed,
        COUNT(*) FILTER (WHERE status='PROCESSING')::int processing,
        COUNT(*) FILTER (WHERE status='SHIPPED')::int shipped,
        COUNT(*) FILTER (WHERE status='DELIVERED')::int delivered,
        COUNT(*) FILTER (WHERE status='CANCELLED')::int cancelled
        FROM seller_orders WHERE seller_id=? AND status<>'AWAITING_PAYMENT'`).get(user.id),
      q(`SELECT
        COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind IN('SELLER_EARNING','SELLER_REVERSAL')),0) AS earned,
        COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind='COMMISSION'),0) AS commission,
        COALESCE((SELECT SUM(subtotal_paisa) FROM seller_orders WHERE seller_id=? AND status='DELIVERED'),0) AS sales,
        COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE seller_id=? AND status IN('REQUESTED','APPROVED')),0) AS reserved,
        COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE seller_id=? AND status='APPROVED'),0) AS paid,
        COALESCE((SELECT SUM(net_paisa) FROM seller_orders WHERE seller_id=? AND status IN('CONFIRMED','PROCESSING','SHIPPED')),0) AS pending`).get(user.id,user.id,user.id,user.id,user.id,user.id),
      q(`SELECT id,order_id,status,subtotal_paisa,commission_paisa,net_paisa,created_at
        FROM seller_orders WHERE seller_id=? AND status<>'AWAITING_PAYMENT'
        ORDER BY created_at DESC,id DESC LIMIT 5`).all(user.id)
    ]);
    return ok({
      shop_status: p.status, products, orders,
      finance: {
        total_sales_bdt: bdt(finance.sales), commission_bdt: bdt(finance.commission),
        net_earnings_bdt: bdt(finance.earned), pending_balance_bdt: bdt(finance.pending),
        available_balance_bdt: bdt(Number(finance.earned) - Number(finance.reserved)),
        paid_out_bdt: bdt(finance.paid)
      },
      recent_orders: recent.map(row => ({
        id: row.id, orderNumber: orderNumber(row.order_id), status: row.status,
        subtotal_bdt: bdt(row.subtotal_paisa), commission_bdt: bdt(row.commission_paisa),
        net_bdt: bdt(row.net_paisa), created_at: row.created_at
      }))
    });
  });

  route('GET', '/api/v1/seller/orders/:id', ['SELLER'], async ({ user, params }) => {
    const order = await q(`SELECT so.id,so.order_id,so.status,so.subtotal_paisa,so.commission_paisa,so.net_paisa,so.created_at,
      o.delivery_name,o.delivery_phone,o.delivery_address,o.delivery_area,o.customer_note,
      o.payment_method,o.payment_status
      FROM seller_orders so JOIN orders o ON o.id=so.order_id
      WHERE so.id=? AND so.seller_id=?`).get(params[0], user.id);
    if (!order) throw new HttpError(404, 'অর্ডারটি পাওয়া যায়নি');
    const items = await q(`SELECT product_id,product_name_bn,quantity,unit_price_paisa,variant
      FROM order_items WHERE seller_order_id=? ORDER BY id`).all(order.id);
    return ok({
      id: order.id, order_id: order.order_id, orderNumber: orderNumber(order.order_id),
      status: order.status, subtotal_bdt: bdt(order.subtotal_paisa),
      commission_bdt: bdt(order.commission_paisa), net_bdt: bdt(order.net_paisa),
      payment: { method: order.payment_method, status: order.payment_status },
      delivery: { name: order.delivery_name, phone: order.delivery_phone, address: order.delivery_address, area: order.delivery_area, note: order.customer_note },
      items: items.map(item => ({ ...item, quantity: Number(item.quantity), unit_price_bdt: bdt(item.unit_price_paisa) })),
      created_at: order.created_at
    });
  });

  route('GET', '/api/v1/seller/analytics', ['SELLER'], async ({ user }) => {
    await profile(user.id);
    const [agg, unitRow, revRow, topRows, dayRows] = await Promise.all([
      q(`SELECT
        SUM(CASE WHEN status<>'AWAITING_PAYMENT' THEN 1 ELSE 0 END)::int AS total_non_await,
        SUM(CASE WHEN status NOT IN ('AWAITING_PAYMENT','CANCELLED') THEN 1 ELSE 0 END)::int AS active_orders,
        SUM(CASE WHEN status='DELIVERED' THEN 1 ELSE 0 END)::int AS delivered_orders,
        COALESCE(SUM(CASE WHEN status NOT IN ('AWAITING_PAYMENT','CANCELLED') THEN subtotal_paisa ELSE 0 END), 0) AS active_paisa
        FROM seller_orders WHERE seller_id=?`).get(user.id),
      q(`SELECT COALESCE(SUM(oi.quantity), 0)::int AS units
        FROM order_items oi JOIN seller_orders so ON so.id=oi.seller_order_id
        WHERE so.seller_id=? AND so.status NOT IN ('AWAITING_PAYMENT','CANCELLED')`).get(user.id),
      q(`SELECT COALESCE(AVG(r.rating), 0) AS avg_rating, COUNT(*)::int AS review_count
        FROM reviews r JOIN products p ON p.id=r.product_id WHERE p.seller_id=?`).get(user.id),
      q(`SELECT oi.product_id, MAX(oi.product_name_bn) AS name_bn,
        SUM(oi.quantity)::int AS units, SUM(oi.quantity * oi.unit_price_paisa) AS revenue_paisa
        FROM order_items oi JOIN seller_orders so ON so.id=oi.seller_order_id
        WHERE so.seller_id=? AND so.status NOT IN ('AWAITING_PAYMENT','CANCELLED')
        GROUP BY oi.product_id ORDER BY units DESC, revenue_paisa DESC LIMIT 5`).all(user.id),
      q(`SELECT substr(created_at, 1, 10) AS day, COUNT(*)::int AS orders, SUM(subtotal_paisa) AS gross_paisa
        FROM seller_orders WHERE seller_id=? AND status NOT IN ('AWAITING_PAYMENT','CANCELLED')
        GROUP BY day ORDER BY day DESC LIMIT 14`).all(user.id)
    ]);
    const activeOrders = Number(agg?.active_orders || 0);
    const deliveredOrders = Number(agg?.delivered_orders || 0);
    const totalNonAwait = Number(agg?.total_non_await || 0);
    return ok({
      avg_order_value_bdt: activeOrders > 0 ? Math.round((bdt(agg?.active_paisa) / activeOrders) * 100) / 100 : 0,
      delivery_rate_pct: totalNonAwait > 0 ? Math.round((deliveredOrders / totalNonAwait) * 1000) / 10 : 0,
      total_units_sold: Number(unitRow?.units || 0),
      average_rating: Math.round(Number(revRow?.avg_rating || 0) * 10) / 10,
      review_count: Number(revRow?.review_count || 0),
      top_products: (topRows || []).map(r => ({ product_id: r.product_id, name_bn: r.name_bn, units: Number(r.units || 0), revenue_bdt: bdt(r.revenue_paisa) })),
      revenue_by_day: (dayRows || []).map(r => ({ day: r.day, orders: Number(r.orders || 0), revenue_bdt: bdt(r.gross_paisa) }))
    });
  });
}
