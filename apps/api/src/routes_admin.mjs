import { q, tx, id, now, audit, notify, text, bad, money, HttpError, bdt, orderNo, normPhone, validPhone, validEmail, slugify } from './core.mjs';
import { applyParentStatus, orderView, sellerBalance, conflict } from './orders.mjs';
import { productFields, parseImages, saveImages, bookShipment, updateShipment } from './routes_seller.mjs';
import { productView, loadStorefrontConfig } from './routes_public.mjs';
import { validateStorefrontConfig } from './storefront-config.mjs';
import {
  pendingRequests,
  decideRequest,
  inventoryAlerts,
  inventoryReport
} from './sqlite-inventory.mjs';

const A = ['ADMIN'];
const lim = (url, d = 100) => Math.min(Math.max(parseInt(url.searchParams.get('limit')) || d, 1), 500);

export function processRefund(refund, actor, { reverse }) {
  const o = q('SELECT * FROM orders WHERE id=?').get(refund.order_id);
  q("UPDATE refunds SET status='APPROVED',decided_at=? WHERE id=? AND status='REQUESTED'").run(now(), refund.id);
  q('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?)').run(id(), 'REFUND', o.id, null, null, -refund.amount_paisa, refund.id, now());
  if (reverse) for (const so of q("SELECT * FROM seller_orders WHERE order_id=? AND status='DELIVERED'").all(o.id)) {
    const amt = Math.round(so.net_paisa * refund.amount_paisa / o.total_paisa);
    if (amt > 0) q('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?)').run(id(), 'SELLER_REVERSAL', o.id, so.id, so.seller_id, -amt, refund.id + ':' + so.id, now());
  }
  const refunded = q("SELECT COALESCE(SUM(amount_paisa),0) s FROM refunds WHERE order_id=? AND status='APPROVED'").get(o.id).s;
  const full = refunded >= o.total_paisa;
  q('UPDATE orders SET payment_status=? WHERE id=?').run(full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', o.id);
  if (full) q("UPDATE payments SET status='REFUNDED',updated_at=? WHERE order_id=? AND status='PAID'").run(now(), o.id);
  audit(actor, 'REFUND_APPROVED', 'refund', refund.id, { amount: refund.amount_paisa, order: o.id });
  notify(o.user_id, 'রিফান্ড অনুমোদিত', orderNo(o.id) + ': ' + bdt(refund.amount_paisa) + ' টাকা');
}

export default function register(route, ok) {
  route('GET', '/api/v1/admin/dashboard', A, () => {
    const n = (sql, ...a) => q(sql).get(...a).n;
    // Revenue means money confirmed as received, not merely order value.
    // COD is marked PAID only after delivery; online payments are marked by verified callbacks.
    const gross = n("SELECT COALESCE(SUM(total_paisa),0) n FROM orders WHERE payment_status='PAID' AND status<>'CANCELLED'");
    return ok({ total_revenue_bdt: bdt(gross), total_orders: n("SELECT COUNT(*) n FROM orders WHERE status<>'AWAITING_PAYMENT'"), total_customers: n("SELECT COUNT(*) n FROM users WHERE role='CUSTOMER'"), total_sellers: n('SELECT COUNT(*) n FROM seller_profiles'),
      pending_seller_applications: n("SELECT COUNT(*) n FROM seller_profiles WHERE status='PENDING'"), pending_product_approvals: n("SELECT COUNT(*) n FROM products WHERE status='PENDING_REVIEW'"),
      total_products: n("SELECT COUNT(*) n FROM products WHERE status<>'ARCHIVED'"), active_products: n("SELECT COUNT(*) n FROM products WHERE status='ACTIVE' AND active=1"), cancelled_orders: n("SELECT COUNT(*) n FROM orders WHERE status='CANCELLED'"),
      pending_payouts: n("SELECT COUNT(*) n FROM payouts WHERE status='REQUESTED'"), pending_payout_amount_bdt: bdt(n("SELECT COALESCE(SUM(amount_paisa),0) n FROM payouts WHERE status='REQUESTED'")),
      platform_commission_bdt: bdt(n("SELECT COALESCE(SUM(amount_paisa),0) n FROM transactions WHERE kind='COMMISSION'")) });
  });

  // ----- customers -----
  route('GET', '/api/v1/admin/customers', A, ({ url }) => {
    const t = '%' + (url.searchParams.get('q') || '').slice(0, 60) + '%';
    return ok(q("SELECT id,name,phone,email,status,created_at,(SELECT COUNT(*) FROM orders o WHERE o.user_id=users.id) orders FROM users WHERE role='CUSTOMER' AND (name LIKE ? OR phone LIKE ? OR COALESCE(email,'') LIKE ?) ORDER BY created_at DESC LIMIT ?").all(t, t, t, lim(url)));
  });
  const customer = cid => { const u = q("SELECT id,name,phone,email,status,phone_verified,email_verified,created_at FROM users WHERE id=? AND role='CUSTOMER'").get(cid); if (!u) throw new HttpError(404, 'Customer not found'); return u; };
  route('GET', '/api/v1/admin/customers/:id', A, ({ params }) => ok({ ...customer(params[0]), addresses: q('SELECT label,name,phone,address,area FROM addresses WHERE user_id=?').all(params[0]), order_count: q('SELECT COUNT(*) n FROM orders WHERE user_id=?').get(params[0]).n }));
  route('GET', '/api/v1/admin/customers/:id/orders', A, ({ params }) => { customer(params[0]); return ok(q('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(params[0]).map(o => orderView(o))); });
  route('PUT', '/api/v1/admin/customers/:id', A, ({ user, params, body }) => {
    const c = customer(params[0]); const name = text(body.name ?? c.name, 100, 'নাম'), phone = normPhone(body.phone ?? c.phone), email = text(body.email ?? c.email, 160, 'ইমেইল', { required: false }).toLowerCase() || null;
    if (!validPhone(phone) || (email && !validEmail(email))) throw bad('মোবাইল বা ইমেইল সঠিক নয়');
    if (q('SELECT 1 FROM users WHERE phone=? AND id<>?').get(phone, c.id) || (email && q('SELECT 1 FROM users WHERE lower(email)=? AND id<>?').get(email, c.id))) throw new HttpError(409, 'মোবাইল বা ইমেইল ব্যবহৃত');
    q('UPDATE users SET name=?,phone=?,email=? WHERE id=?').run(name, phone, email, c.id); audit(user.id, 'CUSTOMER_EDIT', 'user', c.id); return ok(customer(c.id));
  });
  for (const [act, status] of [['suspend', 'SUSPENDED'], ['activate', 'ACTIVE']]) route('POST', '/api/v1/admin/customers/:id/' + act, A, ({ user, params }) => {
    customer(params[0]); tx(() => { q('UPDATE users SET status=? WHERE id=?').run(status, params[0]); if (status === 'SUSPENDED') q('DELETE FROM sessions WHERE user_id=?').run(params[0]); audit(user.id, 'CUSTOMER_' + status, 'user', params[0]); }); return ok({ id: params[0], status });
  });

  // ----- sellers -----
  const SELLER_SQL = 'SELECT u.id,u.name,u.phone,u.email,u.status user_status,sp.shop_name,sp.shop_address,sp.business_info,sp.kyc_nid,sp.kyc_trade_license,sp.status,sp.commission_bps,sp.created_at FROM seller_profiles sp JOIN users u ON u.id=sp.user_id';
  const seller = sid => { const s = q(SELLER_SQL + ' WHERE u.id=?').get(sid); if (!s) throw new HttpError(404, 'Seller not found'); return s; };
  route('GET', '/api/v1/admin/sellers', A, ({ url }) => { const st = url.searchParams.get('status'); return ok(q(SELLER_SQL + (st ? ' WHERE sp.status=?' : '') + ' ORDER BY sp.created_at DESC LIMIT ?').all(...(st ? [st] : []), lim(url))); });
  route('GET', '/api/v1/admin/sellers/:id', A, ({ params }) => { const { available_paisa, ...b } = sellerBalance(params[0]); return ok({ ...seller(params[0]), balance: b, product_count: q("SELECT COUNT(*) n FROM products WHERE seller_id=? AND status<>'ARCHIVED'").get(params[0]).n }); });
  route('GET', '/api/v1/admin/sellers/:id/products', A, ({ params }) => ok(q('SELECT id,name_bn,name_en,price_paisa,discount_paisa,stock,status FROM products WHERE seller_id=? ORDER BY created_at DESC,id DESC').all(params[0]).map(productView)));
  route('GET', '/api/v1/admin/sellers/:id/orders', A, ({ params }) => ok(q('SELECT id,order_id,status,subtotal_paisa,commission_paisa,net_paisa,created_at FROM seller_orders WHERE seller_id=? ORDER BY created_at DESC LIMIT 200').all(params[0]).map(o => ({ id: o.id, orderNumber: orderNo(o.order_id), status: o.status, subtotal_bdt: bdt(o.subtotal_paisa), commission_bdt: bdt(o.commission_paisa), net_bdt: bdt(o.net_paisa), created_at: o.created_at }))));
  route('GET', '/api/v1/admin/sellers/:id/finance', A, ({ params }) => { const { available_paisa, ...b } = sellerBalance(params[0]); return ok(b); });
  const sellerAct = (act, status, userStatus) => route('POST', '/api/v1/admin/sellers/:id/' + act, A, ({ user, params, body }) => {
    const s = seller(params[0]);
    tx(() => { q('UPDATE seller_profiles SET status=? WHERE user_id=?').run(status, s.id); q('UPDATE users SET status=? WHERE id=?').run(userStatus, s.id); if (userStatus === 'SUSPENDED') q('DELETE FROM sessions WHERE user_id=?').run(s.id);
      audit(user.id, 'SELLER_' + status, 'seller', s.id, { reason: String(body.reason || '').slice(0, 300) }); notify(s.id, 'বিক্রেতা অ্যাকাউন্ট: ' + status, String(body.reason || '').slice(0, 300)); });
    return ok({ id: s.id, status });
  });
  sellerAct('approve', 'APPROVED', 'ACTIVE'); sellerAct('reject', 'REJECTED', 'ACTIVE'); sellerAct('suspend', 'SUSPENDED', 'SUSPENDED'); sellerAct('activate', 'APPROVED', 'ACTIVE');
  route('PATCH', '/api/v1/admin/sellers/:id/commission', A, ({ user, params, body }) => {
    const bps = Number(body.commission_bps); if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw bad('কমিশন ০–৫০% এর মধ্যে হতে হবে');
    seller(params[0]); q('UPDATE seller_profiles SET commission_bps=? WHERE user_id=?').run(bps, params[0]); audit(user.id, 'COMMISSION_SET', 'seller', params[0], { bps }); return ok({ id: params[0], commission_bps: bps });
  });

  // ----- products -----
  route('GET', '/api/v1/admin/products', A, ({ url }) => {
    const st = url.searchParams.get('status'), t = '%' + (url.searchParams.get('q') || '') + '%';
    return ok(q(`SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,p.status,c.slug category_slug,sp.shop_name seller_name,(SELECT url FROM product_images i WHERE i.product_id=p.id ORDER BY position LIMIT 1) image FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id
      WHERE p.status<>'ARCHIVED' AND (p.name_bn LIKE ? OR p.name_en LIKE ?)${st ? ' AND p.status=?' : ''} ORDER BY p.created_at DESC,p.id DESC LIMIT ?`).all(t, t, ...(st ? [st] : []), lim(url)).map(productView));
  });
  route('GET', '/api/v1/admin/products/pending', A, () => ok(q("SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,p.status,c.slug category_slug,COALESCE(sp.shop_name,u.name) seller_name,(SELECT url FROM product_images i WHERE i.product_id=p.id ORDER BY position LIMIT 1) image FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN users u ON u.id=p.seller_id LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id WHERE p.status='PENDING_REVIEW' ORDER BY p.created_at,p.id").all().map(productView)));
  const moderate = (act, toStatus, from) => route('POST', '/api/v1/admin/products/:pid/' + act, A, ({ user, params, body }) => {
    const p = q(`SELECT id,seller_id FROM products WHERE id=? AND status IN(${from.map(() => '?').join(',')})`).get(params[0], ...from);
    if (!p) throw new HttpError(404, 'Pending product not found');
    if (toStatus === 'ACTIVE' && q('SELECT status FROM seller_profiles WHERE user_id=?').get(p.seller_id)?.status !== 'APPROVED') throw new HttpError(409, 'আগে বিক্রেতাকে অনুমোদন দিতে হবে');
    q('UPDATE products SET status=?,active=?,updated_at=? WHERE id=?').run(toStatus, toStatus === 'ACTIVE' ? 1 : 0, now(), p.id);
    audit(user.id, 'PRODUCT_' + toStatus, 'product', p.id, { reason: String(body.reason || '').slice(0, 300) }); notify(p.seller_id, 'পণ্যের স্ট্যাটাস: ' + toStatus);
    return ok({ id: p.id, status: toStatus });
  });
  moderate('approve', 'ACTIVE', ['PENDING_REVIEW']); moderate('reject', 'REJECTED', ['PENDING_REVIEW']); moderate('suspend', 'SUSPENDED', ['ACTIVE']); moderate('unsuspend', 'ACTIVE', ['SUSPENDED']);
  route('GET', '/api/v1/admin/products/:id', A, ({ params }) => {
    const p = q(`SELECT p.*,c.slug category_slug,b.slug brand_slug,b.name brand,COALESCE(sp.shop_name,u.name) seller_name
      FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id
      LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id LEFT JOIN users u ON u.id=p.seller_id
      WHERE p.id=? AND p.status<>'ARCHIVED'`).get(params[0]);
    if (!p) throw new HttpError(404, 'Product not found');
    let variants = [];
    try { const parsed = JSON.parse(p.variants || '[]'); if (Array.isArray(parsed)) variants = parsed; } catch {}
    const images = q('SELECT url FROM product_images WHERE product_id=? ORDER BY position').all(p.id).map(i => i.url);
    return ok({ ...productView(p), variants, images, image: images[0] || null });
  });
  route('PUT', '/api/v1/admin/products/:id', A, ({ user, params, body }) => {
    if (!q("SELECT 1 FROM products WHERE id=? AND status<>'ARCHIVED'").get(params[0])) throw new HttpError(404, 'Product not found');
    const f = productFields(body, { partial: true }), imgs = parseImages(body.images), keys = Object.keys(f);
    tx(() => { if (keys.length) q('UPDATE products SET ' + keys.map(k => k + '=?').join(',') + ',updated_at=? WHERE id=?').run(...keys.map(k => f[k]), now(), params[0]); saveImages(params[0], imgs); audit(user.id, 'PRODUCT_ADMIN_EDIT', 'product', params[0]); });
    return ok({ id: params[0] });
  }, { limit: 3000000 });
  route('PATCH', '/api/v1/admin/products/:id/stock', A, ({ user, params, body }) => {
    const s = Number(body.stock); if (!Number.isInteger(s) || s < 0 || s > 1000000) throw bad('স্টক সঠিক নয়');
    if (!q('UPDATE products SET stock=? WHERE id=?').run(s, params[0]).changes) throw new HttpError(404, 'Product not found'); audit(user.id, 'STOCK_UPDATE', 'product', params[0], { stock: s }); return ok({ id: params[0], stock: s });
  });
  route('DELETE', '/api/v1/admin/products/:id', A, ({ user, params }) => {
    if (!q("UPDATE products SET status='ARCHIVED',active=0 WHERE id=? AND status<>'ARCHIVED'").run(params[0]).changes) throw new HttpError(404, 'Product not found'); q('DELETE FROM cart_items WHERE product_id=?').run(params[0]); audit(user.id, 'PRODUCT_DELETE', 'product', params[0]); return ok({ deleted: true });
  });

  // ----- categories & brands -----
  route('POST', '/api/v1/admin/categories', A, ({ user, body }) => { const bn = text(body.name_bn, 80, 'বাংলা নাম'), en = text(body.name_en, 80, 'ইংরেজি নাম', { required: false }), slug = slugify(body.slug || en || bn), cid = id(); q('INSERT INTO categories VALUES(?,?,?,?)').run(cid, slug, bn, en); audit(user.id, 'CATEGORY_CREATE', 'category', cid); return ok({ id: cid, slug }, 201); });
  route('PUT', '/api/v1/admin/categories/:slug', A, ({ user, params, body }) => { if (!q('UPDATE categories SET name_bn=?,name_en=? WHERE slug=?').run(text(body.name_bn, 80, 'বাংলা নাম'), text(body.name_en, 80, 'ইংরেজি নাম', { required: false }), params[0]).changes) throw new HttpError(404, 'Not found'); audit(user.id, 'CATEGORY_EDIT', 'category', params[0]); return ok({ slug: params[0] }); });
  route('DELETE', '/api/v1/admin/categories/:slug', A, ({ user, params }) => { if (q('SELECT 1 FROM products p JOIN categories c ON c.id=p.category_id WHERE c.slug=? LIMIT 1').get(params[0])) throw new HttpError(409, 'ক্যাটাগরিতে পণ্য আছে'); q('DELETE FROM categories WHERE slug=?').run(params[0]); audit(user.id, 'CATEGORY_DELETE', 'category', params[0]); return ok({ deleted: true }); });
  route('POST', '/api/v1/admin/brands', A, ({ user, body }) => { const name = text(body.name, 80, 'ব্র্যান্ড নাম'), bid = id(); q('INSERT INTO brands VALUES(?,?,?)').run(bid, slugify(name), name); audit(user.id, 'BRAND_CREATE', 'brand', bid); return ok({ id: bid, slug: slugify(name) }, 201); });
  route('DELETE', '/api/v1/admin/brands/:slug', A, ({ user, params }) => { q('UPDATE products SET brand_id=NULL WHERE brand_id=(SELECT id FROM brands WHERE slug=?)').run(params[0]); q('DELETE FROM brands WHERE slug=?').run(params[0]); audit(user.id, 'BRAND_DELETE', 'brand', params[0]); return ok({ deleted: true }); });

  // ----- reviews moderation -----
  route('GET', '/api/v1/admin/reviews', A, ({ url }) => {
    const term = '%' + String(url.searchParams.get('q') || '').trim().slice(0, 60) + '%';
    return ok(q(`SELECT r.id,r.product_id,r.user_id,r.rating,r.comment,r.created_at,
      p.name_bn AS product_name_bn,p.name_en AS product_name_en,u.name AS customer_name,u.phone AS customer_phone
      FROM reviews r JOIN products p ON p.id=r.product_id JOIN users u ON u.id=r.user_id
      WHERE (p.name_bn LIKE ? OR p.name_en LIKE ? OR u.name LIKE ? OR COALESCE(r.comment,'') LIKE ?)
      ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).all(term, term, term, term, lim(url, 100)));
  });
  route('DELETE', '/api/v1/admin/reviews/:id', A, ({ user, params }) => {
    const rev = q('SELECT id,product_id,user_id,rating FROM reviews WHERE id=?').get(params[0]);
    if (!rev) throw new HttpError(404, 'Review not found');
    tx(() => {
      q('DELETE FROM reviews WHERE id=?').run(rev.id);
      audit(user.id, 'REVIEW_DELETE', 'review', rev.id, { product_id: rev.product_id, rating: rev.rating });
    });
    return ok({ id: rev.id, deleted: true });
  });

  // ----- orders -----
  const adminOrder = o => ({ ...orderView(o), admin_note: o.admin_note, customer: q('SELECT name,phone,email FROM users WHERE id=?').get(o.user_id),
    sellers: q('SELECT so.id,so.status,so.subtotal_paisa,so.commission_paisa,sp.shop_name FROM seller_orders so LEFT JOIN seller_profiles sp ON sp.user_id=so.seller_id WHERE so.order_id=?').all(o.id).map(s => ({ id: s.id, shop: s.shop_name, status: s.status, subtotal_bdt: bdt(s.subtotal_paisa), commission_bdt: bdt(s.commission_paisa), shipment: q('SELECT id,provider,tracking_id,status FROM shipments WHERE seller_order_id=? ORDER BY created_at DESC LIMIT 1').get(s.id) || null })) });
  route('GET', '/api/v1/admin/orders', A, ({ url }) => {
    const st = url.searchParams.get('status'), t = '%' + (url.searchParams.get('q') || '') + '%';
    return ok(q(`SELECT o.* FROM orders o JOIN users u ON u.id=o.user_id WHERE (o.id LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)${st ? ' AND o.status=?' : ''} ORDER BY o.created_at DESC,o.id DESC LIMIT ?`).all(t.replace('BD-', '').toLowerCase(), t, t, ...(st ? [st] : []), lim(url, 200)).map(adminOrder));
  });
  const order = oid => q('SELECT * FROM orders WHERE id=?').get(oid) || (() => { throw new HttpError(404, 'Order not found'); })();
  route('GET', '/api/v1/admin/orders/:id', A, ({ params }) => ok({ ...adminOrder(order(params[0])), history: q('SELECT status,note,created_at,seller_order_id,actor_id FROM order_events WHERE order_id=? ORDER BY created_at,id').all(params[0]), payments: q('SELECT id,method,amount_paisa,status,gateway_txn_id,created_at FROM payments WHERE order_id=? ORDER BY created_at').all(params[0]).map(p => ({ ...p, amount_bdt: bdt(p.amount_paisa) })) }));
  route('POST', '/api/v1/admin/orders/:id/status', A, ({ user, params, body }) => {
    const next = String(body.status || '');
    if (!['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(next)) throw bad('Invalid order status');
    order(params[0]); return ok({ id: params[0], status: applyParentStatus(params[0], next, user.id, text(body.note, 300, 'নোট', { required: false })) });
  });
  route('POST', '/api/v1/admin/orders/:id/note', A, ({ user, params, body }) => { order(params[0]); q('UPDATE orders SET admin_note=? WHERE id=?').run(text(body.note, 1000, 'নোট', { required: false }), params[0]); audit(user.id, 'ORDER_NOTE', 'order', params[0]); return ok({ saved: true }); });
  route('POST', '/api/v1/admin/orders/:id/shipping', A, ({ user, params, body }) => {
    const ship = Math.round(Number(body.shipping_bdt) * 100); if (!Number.isSafeInteger(ship) || ship < 0 || ship > 1e7) throw bad('ডেলিভারি চার্জ সঠিক নয়');
    return ok(tx(() => { const o = order(params[0]);
      if (o.payment_status !== 'PENDING' || !['AWAITING_PAYMENT', 'CONFIRMED', 'PROCESSING'].includes(o.status)) throw conflict();
      const total = o.subtotal_paisa + ship - o.discount_paisa;
      q('UPDATE orders SET shipping_paisa=?,total_paisa=? WHERE id=?').run(ship, total, o.id); q("UPDATE payments SET amount_paisa=? WHERE order_id=? AND status IN('PENDING','INITIATED')").run(total, o.id);
      audit(user.id, 'SHIPPING_CHARGE_SET', 'order', o.id, { from: o.shipping_paisa, to: ship }); return { id: o.id, shipping_bdt: bdt(ship), total_bdt: bdt(total) }; }));
  });
  route('POST', '/api/v1/admin/seller-orders/:id/courier', A, ({ user, params, body }) => ok(tx(() => {
    const so = q('SELECT so.*,o.delivery_area FROM seller_orders so JOIN orders o ON o.id=so.order_id WHERE so.id=?').get(params[0]); if (!so) throw new HttpError(404, 'Not found');
    if (!['PROCESSING', 'SHIPPED'].includes(so.status)) throw conflict();
    if (q("SELECT 1 FROM shipments WHERE seller_order_id=? AND status NOT IN('FAILED_DELIVERY','RETURNED')").get(so.id)) throw new HttpError(409, 'ইতিমধ্যে কুরিয়ার বুক করা আছে');
    return bookShipment(so, String(body.provider || '').toUpperCase(), so.delivery_area, user.id); }), 201));
  route('POST', '/api/v1/admin/shipments/:id/status', A, ({ user, params, body }) => { const sh = q('SELECT * FROM shipments WHERE id=?').get(params[0]); if (!sh) throw new HttpError(404, 'Shipment not found'); updateShipment(sh, String(body.status || ''), user.id); return ok({ id: sh.id, status: body.status }); });

  // ----- refunds -----
  route('GET', '/api/v1/admin/refunds', A, () => ok(q('SELECT id,order_id,amount_paisa,reason,status,created_at,decided_at FROM refunds ORDER BY created_at DESC LIMIT 200').all().map(r => ({ ...r, orderNumber: orderNo(r.order_id), amount_bdt: bdt(r.amount_paisa) }))));
  route('POST', '/api/v1/admin/orders/:id/refund', A, ({ user, params, body }) => ok(tx(() => {
    const o = order(params[0]); if (!['PAID', 'PARTIALLY_REFUNDED'].includes(o.payment_status)) throw new HttpError(409, 'পেমেন্ট সম্পন্ন না হলে রিফান্ড করা যায় না');
    const amt = money(body.amount_bdt, 'রিফান্ড পরিমাণ'), done = q("SELECT COALESCE(SUM(amount_paisa),0) s FROM refunds WHERE order_id=? AND status<>'REJECTED'").get(o.id).s;
    if (amt > o.total_paisa - done) throw new HttpError(409, 'রিফান্ড পরিমাণ অর্ডারের পরিশোধিত অংশের বেশি');
    const r = { id: id(), order_id: o.id, amount_paisa: amt }; q('INSERT INTO refunds VALUES(?,?,?,?,?,?,NULL)').run(r.id, o.id, amt, text(body.reason, 300, 'কারণ'), 'REQUESTED', now());
    processRefund(r, user.id, { reverse: true }); return { id: r.id, status: 'APPROVED' }; }), 201));
  route('POST', '/api/v1/admin/refunds/:id/approve', A, ({ user, params }) => ok(tx(() => {
    const r = q("SELECT * FROM refunds WHERE id=? AND status='REQUESTED'").get(params[0]); if (!r) throw new HttpError(404, 'Refund request not found');
    processRefund(r, user.id, { reverse: !/বাতিল/.test(r.reason) }); return { id: r.id, status: 'APPROVED' }; })));
  route('POST', '/api/v1/admin/refunds/:id/reject', A, ({ user, params }) => { if (!q("UPDATE refunds SET status='REJECTED',decided_at=? WHERE id=? AND status='REQUESTED'").run(now(), params[0]).changes) throw new HttpError(404, 'Refund request not found'); audit(user.id, 'REFUND_REJECTED', 'refund', params[0]); return ok({ id: params[0], status: 'REJECTED' }); });

  // ----- payouts -----
  route('GET', '/api/v1/admin/payouts', A, ({ url }) => { const st = url.searchParams.get('status');
    return ok(q('SELECT p.*,sp.shop_name FROM payouts p LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id' + (st ? ' WHERE p.status=?' : '') + ' ORDER BY p.created_at DESC LIMIT 200').all(...(st ? [st] : [])).map(p => ({ id: p.id, seller_id: p.seller_id, shop: p.shop_name, amount_bdt: bdt(p.amount_paisa), method: p.method, account: p.account, status: p.status, note: p.note, created_at: p.created_at, decided_at: p.decided_at }))); });
  route('POST', '/api/v1/admin/payouts/:id/approve', A, ({ user, params, body }) => ok(tx(() => {
    const p = q("SELECT * FROM payouts WHERE id=? AND status='REQUESTED'").get(params[0]); if (!p) throw new HttpError(404, 'Payout request not found');
    q("UPDATE payouts SET status='APPROVED',decided_at=?,note=? WHERE id=?").run(now(), text(body.note, 300, 'নোট', { required: false }), p.id);
    q('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?)').run(id(), 'PAYOUT', null, null, p.seller_id, -p.amount_paisa, p.id, now());
    audit(user.id, 'PAYOUT_APPROVED', 'payout', p.id, { amount: p.amount_paisa }); notify(p.seller_id, 'পেআউট অনুমোদিত', bdt(p.amount_paisa) + ' টাকা'); return { id: p.id, status: 'APPROVED' }; })));
  route('POST', '/api/v1/admin/payouts/:id/reject', A, ({ user, params, body }) => {
    const p = q("SELECT * FROM payouts WHERE id=? AND status='REQUESTED'").get(params[0]); if (!p) throw new HttpError(404, 'Payout request not found');
    q("UPDATE payouts SET status='REJECTED',decided_at=?,note=? WHERE id=?").run(now(), text(body.note, 300, 'কারণ', { required: false }), p.id); audit(user.id, 'PAYOUT_REJECTED', 'payout', p.id); notify(p.seller_id, 'পেআউট প্রত্যাখ্যাত'); return ok({ id: p.id, status: 'REJECTED' });
  });

  // ----- finance -----
  route('GET', '/api/v1/admin/finance/summary', A, () => {
    const n = (sql) => q(sql).get().n;
    const gross = n("SELECT COALESCE(SUM(total_paisa),0) n FROM orders WHERE status NOT IN('CANCELLED','AWAITING_PAYMENT')"), refunds = n("SELECT COALESCE(SUM(amount_paisa),0) n FROM refunds WHERE status='APPROVED'");
    const avail = q("SELECT user_id FROM seller_profiles").all().reduce((s, r) => s + sellerBalance(r.user_id).available_paisa, 0);
    return ok({ gross_sales_bdt: bdt(gross), refunds_bdt: bdt(refunds), net_sales_bdt: bdt(gross - refunds), platform_commission_bdt: bdt(n("SELECT COALESCE(SUM(amount_paisa),0) n FROM transactions WHERE kind='COMMISSION'")),
      seller_available_balance_bdt: bdt(avail), seller_pending_balance_bdt: bdt(n("SELECT COALESCE(SUM(net_paisa),0) n FROM seller_orders WHERE status IN('CONFIRMED','PROCESSING','SHIPPED')")),
      paid_out_bdt: bdt(n("SELECT COALESCE(SUM(amount_paisa),0) n FROM payouts WHERE status='APPROVED'")), pending_payouts_bdt: bdt(n("SELECT COALESCE(SUM(amount_paisa),0) n FROM payouts WHERE status='REQUESTED'")) });
  });
  route('GET', '/api/v1/admin/finance/transactions', A, ({ url }) => { const k = url.searchParams.get('kind');
    return ok(q('SELECT id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at FROM transactions' + (k ? ' WHERE kind=?' : '') + ' ORDER BY created_at DESC,id DESC LIMIT ?').all(...(k ? [k] : []), lim(url, 200)).map(t => ({ ...t, amount_bdt: bdt(t.amount_paisa) }))); });
  route('GET', '/api/v1/admin/finance/report', A, ({ url }) => {
    const from = (url.searchParams.get('from') || '0000').slice(0, 10), to = (url.searchParams.get('to') || '9999').slice(0, 10) + 'T99';
    return ok(q("SELECT substr(created_at,1,10) day,COUNT(*) orders,SUM(total_paisa) gross FROM orders WHERE status NOT IN('CANCELLED','AWAITING_PAYMENT') AND created_at>=? AND created_at<=? GROUP BY day ORDER BY day").all(from, to).map(r => ({ day: r.day, orders: r.orders, gross_bdt: bdt(r.gross) })));
  });
  route('GET', '/api/v1/admin/reports/summary', A, ({ url }) => {
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const rawSellerId = url.searchParams.get('seller_id');
    const sellerId = rawSellerId === null || rawSellerId === undefined || rawSellerId === '' ? null : rawSellerId;
    const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00.000Z')) && new Date(Date.parse(v + 'T00:00:00.000Z')).toISOString().slice(0, 10) === v;
    if (!validDate(from) || !validDate(to)) throw bad('রিপোর্টের from ও to তারিখ YYYY-MM-DD ফরম্যাটে দিতে হবে');
    const days = (Date.parse(to + 'T00:00:00.000Z') - Date.parse(from + 'T00:00:00.000Z')) / 86400000 + 1;
    if (days < 1 || days > 366) throw bad('রিপোর্টের তারিখসীমা সর্বোচ্চ ৩৬৬ দিন হতে পারে');
    if (sellerId !== null && !/^[A-Za-z0-9_-]{1,160}$/.test(sellerId)) throw bad('বিক্রেতার আইডি সঠিক নয়');
    const startIso = new Date(Date.parse(from + 'T00:00:00+06:00')).toISOString();
    const endIso = new Date(Date.parse(to + 'T00:00:00+06:00') + 86400000).toISOString();

    const om = sellerId === null
      ? q(`SELECT COUNT(*) AS orders_count,
          SUM(CASE WHEN payment_status='PAID' AND status<>'CANCELLED' THEN 1 ELSE 0 END) AS paid_orders_count,
          SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END) AS cancelled_orders_count,
          SUM(CASE WHEN payment_method='COD' AND payment_status<>'PAID' AND status<>'CANCELLED' THEN 1 ELSE 0 END) AS unpaid_cod_orders_count,
          COALESCE(SUM(CASE WHEN payment_status='PAID' AND status<>'CANCELLED' THEN subtotal_paisa ELSE 0 END),0) AS gross_merchandise_paisa,
          COALESCE(SUM(CASE WHEN payment_status='PAID' AND status<>'CANCELLED' THEN discount_paisa ELSE 0 END),0) AS discounts_paisa,
          COALESCE(SUM(CASE WHEN payment_status='PAID' AND status<>'CANCELLED' THEN shipping_paisa ELSE 0 END),0) AS shipping_paisa
          FROM orders WHERE created_at>=? AND created_at<?`).get(startIso, endIso)
      : q(`SELECT COUNT(*) AS orders_count,
          SUM(CASE WHEN o.payment_status='PAID' AND o.status<>'CANCELLED' THEN 1 ELSE 0 END) AS paid_orders_count,
          SUM(CASE WHEN o.status='CANCELLED' THEN 1 ELSE 0 END) AS cancelled_orders_count,
          SUM(CASE WHEN o.payment_method='COD' AND o.payment_status<>'PAID' AND o.status<>'CANCELLED' THEN 1 ELSE 0 END) AS unpaid_cod_orders_count,
          COALESCE(SUM(CASE WHEN o.payment_status='PAID' AND o.status<>'CANCELLED' THEN so.subtotal_paisa ELSE 0 END),0) AS gross_merchandise_paisa,
          0 AS discounts_paisa,
          0 AS shipping_paisa
          FROM orders o JOIN seller_orders so ON so.order_id=o.id AND so.seller_id=?
          WHERE o.created_at>=? AND o.created_at<?`).get(sellerId, startIso, endIso);

    const lm = q(`SELECT
        COALESCE(SUM(CASE WHEN kind='COMMISSION' THEN amount_paisa ELSE 0 END),0) AS platform_commission_paisa,
        COALESCE(SUM(CASE WHEN kind='SELLER_EARNING' THEN amount_paisa ELSE 0 END),0) AS seller_earnings_paisa,
        COALESCE(SUM(CASE WHEN kind='SELLER_REVERSAL' THEN amount_paisa ELSE 0 END),0) AS seller_reversals_paisa
      FROM transactions WHERE created_at>=? AND created_at<?${sellerId !== null ? ' AND seller_id=?' : ''}`)
      .get(...(sellerId !== null ? [startIso, endIso, sellerId] : [startIso, endIso]));

    const rm = sellerId === null
      ? q(`SELECT
          SUM(CASE WHEN status='REQUESTED' THEN 1 ELSE 0 END) AS requested_refund_count,
          COALESCE(SUM(CASE WHEN status='REQUESTED' THEN amount_paisa ELSE 0 END),0) AS requested_refund_paisa
          FROM refunds WHERE created_at>=? AND created_at<?`).get(startIso, endIso)
      : null;

    const pm = q(`SELECT
        SUM(CASE WHEN status='REQUESTED' THEN 1 ELSE 0 END) AS requested_payout_count,
        COALESCE(SUM(CASE WHEN status='REQUESTED' THEN amount_paisa ELSE 0 END),0) AS requested_payout_paisa,
        SUM(CASE WHEN status='APPROVED' THEN 1 ELSE 0 END) AS approved_payout_count,
        COALESCE(SUM(CASE WHEN status='APPROVED' THEN amount_paisa ELSE 0 END),0) AS approved_payout_paisa,
        SUM(CASE WHEN status='REJECTED' THEN 1 ELSE 0 END) AS rejected_payout_count,
        COALESCE(SUM(CASE WHEN status='REJECTED' THEN amount_paisa ELSE 0 END),0) AS rejected_payout_paisa
      FROM payouts WHERE created_at>=? AND created_at<?${sellerId !== null ? ' AND seller_id=?' : ''}`)
      .get(...(sellerId !== null ? [startIso, endIso, sellerId] : [startIso, endIso]));

    const gross = Number(om?.gross_merchandise_paisa || 0);
    const discounts = Number(om?.discounts_paisa || 0);
    const net = Math.max(0, gross - discounts);
    const moneyObj = v => ({ paisa: Number(v || 0), bdt: bdt(Number(v || 0)) });
    return ok({
      period: { from, to, time_zone: 'Asia/Dhaka', seller_id: sellerId },
      date_basis: {
        orders: 'orders.created_at',
        financial_ledger: 'transactions.created_at',
        refunds: 'refunds.created_at',
        payouts: 'payouts.created_at'
      },
      orders: {
        total: Number(om?.orders_count || 0),
        paid: Number(om?.paid_orders_count || 0),
        cancelled: Number(om?.cancelled_orders_count || 0),
        unpaid_cod: Number(om?.unpaid_cod_orders_count || 0)
      },
      sales: {
        gross_merchandise: moneyObj(gross),
        discounts: moneyObj(discounts),
        net_merchandise: moneyObj(net),
        shipping: sellerId === null ? moneyObj(om?.shipping_paisa) : null
      },
      finance: {
        platform_commission: moneyObj(lm?.platform_commission_paisa),
        seller_earnings: moneyObj(lm?.seller_earnings_paisa),
        seller_reversals: moneyObj(lm?.seller_reversals_paisa)
      },
      refunds: sellerId === null ? {
        requested_count: Number(rm?.requested_refund_count || 0),
        requested_amount: moneyObj(rm?.requested_refund_paisa)
      } : null,
      payouts: {
        requested_count: Number(pm?.requested_payout_count || 0),
        requested_amount: moneyObj(pm?.requested_payout_paisa),
        approved_count: Number(pm?.approved_payout_count || 0),
        approved_amount: moneyObj(pm?.approved_payout_paisa),
        rejected_count: Number(pm?.rejected_payout_count || 0),
        rejected_amount: moneyObj(pm?.rejected_payout_paisa)
      }
    });
  });
  route('GET', '/api/v1/admin/audit-logs', A, ({ url }) => ok(q('SELECT id,actor_id,action,entity,entity_id,detail,created_at FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT ?').all(lim(url, 200))));

  // ----- coupons -----
  route('GET', '/api/v1/admin/coupons', A, () => ok(q('SELECT * FROM coupons ORDER BY code').all()));
  route('POST', '/api/v1/admin/coupons', A, ({ user, body }) => {
    const code = text(body.code, 30, 'কুপন কোড').toUpperCase(); if (!/^[A-Z0-9_-]+$/.test(code)) throw bad('কোডে শুধু ইংরেজি অক্ষর, সংখ্যা, - ও _');
    const type = body.type === 'FIXED' ? 'FIXED' : 'PERCENT', value = type === 'FIXED' ? money(body.value, 'ছাড়') : Number(body.value);
    if (type === 'PERCENT' && (!Number.isInteger(value) || value < 1 || value > 90)) throw bad('শতাংশ ১–৯০ হতে হবে');
    q('INSERT INTO coupons VALUES(?,?,?,?,?,0,?,1)').run(code, type, value, Math.round(Number(body.min_order_bdt || 0) * 100), body.max_uses ? Number(body.max_uses) : null, body.expires_at ? String(body.expires_at) : null);
    audit(user.id, 'COUPON_CREATE', 'coupon', code); return ok({ code }, 201);
  });
  route('PATCH', '/api/v1/admin/coupons/:code', A, ({ user, params, body }) => { if (!q('UPDATE coupons SET active=? WHERE code=?').run(body.active ? 1 : 0, params[0].toUpperCase()).changes) throw new HttpError(404, 'Coupon not found'); audit(user.id, 'COUPON_TOGGLE', 'coupon', params[0]); return ok({ code: params[0], active: !!body.active }); });

  // ----- inventory approval workspace -----
  route('GET', '/api/v1/admin/inventory/adjustments', A, ({ url }) => ok(pendingRequests(url.searchParams.get('status') || 'PENDING')));
  route('POST', '/api/v1/admin/inventory/adjustments/:id/decision', A, ({ user, params, body }) => ok(decideRequest(user, params[0], body)));
  route('GET', '/api/v1/admin/inventory/alerts', A, ({ url }) => ok(inventoryAlerts({ threshold: url.searchParams.get('threshold') ?? 5 })));
  route('GET', '/api/v1/admin/inventory/report', A, ({ url }) => ok(inventoryReport({ from: url.searchParams.get('from'), to: url.searchParams.get('to') })));

  // ----- storefront banner, delivery & platform settings -----
  route('GET', '/api/v1/admin/storefront/config', A, () => ok(loadStorefrontConfig()));
  route('PUT', '/api/v1/admin/storefront/config', A, ({ user, body }) => {
    const current = loadStorefrontConfig();
    const validated = validateStorefrontConfig(body, current);
    const { _changed, ...nextConfig } = validated;
    const ts = now();
    tx(() => {
      for (const [k, v] of Object.entries(_changed)) {
        q('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
          .run(k, String(v), ts);
      }
      audit(user.id, 'STOREFRONT_CONFIG_UPDATE', 'platform_settings', 'storefront', _changed);
    });
    return ok(nextConfig);
  });
}
