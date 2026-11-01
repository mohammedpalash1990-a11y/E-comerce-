import { q, tx, id, now, audit, notify, text, bad, money, HttpError, bdt, orderNo } from './core.mjs';
import { applySellerStatus, sellerBalance, addEvent } from './orders.mjs';
import { courierBook, courierQuote, COURIERS, SHIPMENT_STATUSES } from './gateways.mjs';
import { productView } from './routes_public.mjs';

const S = ['SELLER'];
const profile = u => q('SELECT * FROM seller_profiles WHERE user_id=?').get(u.id) || (() => { throw new HttpError(403, 'বিক্রেতা প্রোফাইল পাওয়া যায়নি'); })();

export function parseImages(list) {
  if (list === undefined) return null;
  if (!Array.isArray(list) || list.length > 6) throw bad('সর্বোচ্চ ৬টি ছবি দেওয়া যায়');
  return list.map(u => { u = String(u);
    if (/^https:\/\/[^\s"'<>]+$/i.test(u) && u.length <= 500) return u;
    if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length <= 400000) return u;
    throw bad('ছবি শুধু https লিংক বা ছোট PNG/JPEG/WebP হতে পারে'); });
}
function parseVariants(v) {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length > 30) throw bad('ভ্যারিয়েন্ট তালিকা সঠিক নয়');
  return JSON.stringify(v.map(x => ({ label: text(x.label, 60, 'ভ্যারিয়েন্ট'), sku: text(x.sku, 40, 'SKU', { required: false }) })));
}
export function productFields(body, { partial = false } = {}) {
  const f = {};
  const set = (k, v) => { if (v !== undefined) f[k] = v; };
  if (!partial || body.name_bn !== undefined) set('name_bn', text(body.name_bn, 160, 'বাংলা নাম'));
  if (!partial || body.name_en !== undefined) set('name_en', text(body.name_en, 160, 'ইংরেজি নাম'));
  if (!partial || body.price_bdt !== undefined) set('price_paisa', money(body.price_bdt, 'মূল্য'));
  if (body.discount_price_bdt !== undefined) set('discount_paisa', body.discount_price_bdt === null || body.discount_price_bdt === '' ? null : money(body.discount_price_bdt, 'ডিসকাউন্ট মূল্য'));
  if (f.discount_paisa && f.price_paisa && f.discount_paisa >= f.price_paisa) throw bad('ডিসকাউন্ট মূল্য মূল্যের চেয়ে কম হতে হবে');
  if (!partial || body.stock !== undefined) { const s = Number(body.stock); if (!Number.isInteger(s) || s < 0 || s > 1000000) throw bad('স্টক সঠিক নয়'); set('stock', s); }
  if (body.description !== undefined) set('description', text(body.description, 5000, 'বিবরণ', { required: false }));
  if (body.sku !== undefined) set('sku', text(body.sku, 40, 'SKU', { required: false }) || null);
  if (body.category_slug !== undefined || !partial) { const c = q('SELECT id FROM categories WHERE slug=?').get(String(body.category_slug || '')); if (!c) throw bad('ক্যাটাগরি সঠিক নয়'); set('category_id', c.id); }
  if (body.brand_slug !== undefined) { if (!body.brand_slug) set('brand_id', null); else { const b = q('SELECT id FROM brands WHERE slug=?').get(String(body.brand_slug)); if (!b) throw bad('ব্র্যান্ড সঠিক নয়'); set('brand_id', b.id); } }
  const v = parseVariants(body.variants); if (v !== null) set('variants', v);
  return f;
}
export function saveImages(pid, imgs) { if (imgs === null) return; q('DELETE FROM product_images WHERE product_id=?').run(pid); imgs.forEach((u, i) => q('INSERT INTO product_images VALUES(?,?,?,?)').run(id(), pid, u, i)); }
const sellerProductRow = (pid, uid) => q('SELECT * FROM products WHERE id=? AND seller_id=? AND status<>\'ARCHIVED\'').get(pid, uid);

export function bookShipment(so, provider, area, actor) {
  const b = courierBook(provider, area);
  q('INSERT INTO shipments VALUES(?,?,?,?,?,?,?,?)').run(id(), so.id, provider, b.trackingId, b.status, b.charge, 'sandbox', now());
  addEvent(so.order_id, so.id, 'COURIER_BOOKED', provider + ' ' + b.trackingId, actor);
  return { provider, tracking_id: b.trackingId, status: b.status, charge_bdt: bdt(b.charge) };
}
export function updateShipment(sh, status, actor) {
  if (!SHIPMENT_STATUSES.includes(status)) throw bad('Invalid shipment status');
  tx(() => {
    q('UPDATE shipments SET status=? WHERE id=?').run(status, sh.id);
    const so = q('SELECT * FROM seller_orders WHERE id=?').get(sh.seller_order_id);
    addEvent(so.order_id, so.id, 'COURIER_' + status, sh.provider + ' ' + sh.tracking_id, actor);
    if (status === 'DELIVERED' && so.status === 'SHIPPED') applySellerStatus(so, 'DELIVERED', actor, 'কুরিয়ার ডেলিভারি নিশ্চিত');
    if (status === 'FAILED_DELIVERY' || status === 'RETURNED') notify(q('SELECT user_id FROM orders WHERE id=?').get(so.order_id).user_id, 'ডেলিভারি আপডেট', status);
    audit(actor, 'SHIPMENT_' + status, 'shipment', sh.id);
  });
}

export default function register(route, ok) {
  route('GET', '/api/v1/seller/profile', S, ({ user }) => ok(profile(user)));
  route('GET', '/api/v1/seller/dashboard', S, ({ user }) => {
    const p = profile(user), n = (sql, ...a) => q(sql).get(...a).n;
    const so = st => n('SELECT COUNT(*) n FROM seller_orders WHERE seller_id=? AND status=?', user.id, st);
    const b = sellerBalance(user.id);
    return ok({ shop_status: p.status, products: { total: n("SELECT COUNT(*) n FROM products WHERE seller_id=? AND status<>'ARCHIVED'", user.id), pending: n("SELECT COUNT(*) n FROM products WHERE seller_id=? AND status='PENDING_REVIEW'", user.id), approved: n("SELECT COUNT(*) n FROM products WHERE seller_id=? AND status='ACTIVE'", user.id) },
      orders: { total: n("SELECT COUNT(*) n FROM seller_orders WHERE seller_id=? AND status<>'AWAITING_PAYMENT'", user.id), pending: so('CONFIRMED'), processing: so('PROCESSING'), shipped: so('SHIPPED'), delivered: so('DELIVERED'), cancelled: so('CANCELLED') },
      total_sales_bdt: b.total_sales_bdt, commission_bdt: b.commission_bdt, balance: { available_bdt: b.available_balance_bdt, pending_bdt: b.pending_balance_bdt },
      recent_orders: q("SELECT id,order_id,status,subtotal_paisa,created_at FROM seller_orders WHERE seller_id=? AND status<>'AWAITING_PAYMENT' ORDER BY created_at DESC LIMIT 5").all(user.id).map(o => ({ id: o.id, orderNumber: orderNo(o.order_id), status: o.status, subtotal_bdt: bdt(o.subtotal_paisa), created_at: o.created_at })) });
  });

  // ----- products -----
  route('GET', '/api/v1/seller/products', S, ({ user }) => ok(q(`SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,p.status,p.sku,c.slug category_slug,
    (SELECT url FROM product_images i WHERE i.product_id=p.id ORDER BY position LIMIT 1) image FROM products p JOIN categories c ON c.id=p.category_id WHERE p.seller_id=? AND p.status<>'ARCHIVED' ORDER BY p.rowid DESC`).all(user.id).map(productView)));
  route('GET', '/api/v1/seller/products/:id', S, ({ user, params }) => {
    const p = sellerProductRow(params[0], user.id); if (!p) throw new HttpError(404, 'Product not found');
    return ok({ ...productView(p), variants: JSON.parse(p.variants || '[]'), images: q('SELECT url FROM product_images WHERE product_id=? ORDER BY position').all(p.id).map(i => i.url) });
  });
  route('POST', '/api/v1/seller/products', S, ({ user, body }) => {
    const sp = profile(user); if (!['PENDING', 'APPROVED'].includes(sp.status)) throw new HttpError(403, 'আপনার বিক্রেতা অ্যাকাউন্ট দিয়ে পণ্য যোগ করা যাবে না');
    const f = productFields(body), imgs = parseImages(body.images), pid = id(), ts = now();
    tx(() => {
      q("INSERT INTO products(id,category_id,name_bn,name_en,price_paisa,stock,active,seller_id,status,description,discount_paisa,sku,variants,brand_id,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,'PENDING_REVIEW',?,?,?,?,?,?,?)")
        .run(pid, f.category_id, f.name_bn, f.name_en, f.price_paisa, f.stock, user.id, f.description || '', f.discount_paisa ?? null, f.sku ?? null, f.variants || '[]', f.brand_id ?? null, ts, ts);
      saveImages(pid, imgs); audit(user.id, 'PRODUCT_SUBMIT', 'product', pid);
    });
    return ok({ id: pid, status: 'PENDING_REVIEW', message: 'পণ্যটি অ্যাডমিন অনুমোদনের অপেক্ষায় আছে' }, 201);
  }, { limit: 3000000 });
  route('PUT', '/api/v1/seller/products/:id', S, ({ user, params, body }) => {
    const p = sellerProductRow(params[0], user.id); if (!p) throw new HttpError(404, 'Product not found');
    if (profile(user).status === 'SUSPENDED' || profile(user).status === 'REJECTED') throw new HttpError(403, 'অনুমতি নেই');
    const f = productFields(body, { partial: true }), imgs = parseImages(body.images);
    tx(() => {
      const keys = Object.keys(f);
      if (keys.length) q('UPDATE products SET ' + keys.map(k => k + '=?').join(',') + ",status='PENDING_REVIEW',active=0,updated_at=? WHERE id=?").run(...keys.map(k => f[k]), now(), p.id);
      else if (imgs !== null) q("UPDATE products SET status='PENDING_REVIEW',active=0,updated_at=? WHERE id=?").run(now(), p.id);
      saveImages(p.id, imgs); audit(user.id, 'PRODUCT_EDIT', 'product', p.id);
    });
    return ok({ id: p.id, status: 'PENDING_REVIEW', message: 'পরিবর্তনের পর পণ্যটি আবার অ্যাডমিন অনুমোদনের অপেক্ষায়' });
  }, { limit: 3000000 });
  route('PATCH', '/api/v1/seller/products/:id/stock', S, ({ user, params, body }) => {
    const s = Number(body.stock); if (!Number.isInteger(s) || s < 0 || s > 1000000) throw bad('স্টক সঠিক নয়');
    if (!q('UPDATE products SET stock=?,updated_at=? WHERE id=? AND seller_id=?').run(s, now(), params[0], user.id).changes) throw new HttpError(404, 'Product not found');
    audit(user.id, 'STOCK_UPDATE', 'product', params[0], { stock: s }); return ok({ id: params[0], stock: s });
  });
  route('DELETE', '/api/v1/seller/products/:id', S, ({ user, params }) => {
    if (!q("UPDATE products SET status='ARCHIVED',active=0,updated_at=? WHERE id=? AND seller_id=? AND status<>'ARCHIVED'").run(now(), params[0], user.id).changes) throw new HttpError(404, 'Product not found');
    q('DELETE FROM cart_items WHERE product_id=?').run(params[0]); audit(user.id, 'PRODUCT_DELETE', 'product', params[0]); return ok({ deleted: true });
  });

  // ----- orders (seller sees only own sub-orders) -----
  const subView = o => ({
    id: o.id, orderNumber: orderNo(o.order_id), status: o.status, subtotal_bdt: bdt(o.subtotal_paisa), commission_bdt: bdt(o.commission_paisa), net_bdt: bdt(o.net_paisa), created_at: o.created_at,
    payment: { method: o.payment_method, status: o.payment_status },
    customer: { name: o.customer_name, phone: o.customer_phone },
    delivery: { name: o.delivery_name, phone: o.delivery_phone, address: o.delivery_address, area: o.delivery_area, note: o.customer_note },
    items: q('SELECT product_name_bn,quantity,unit_price_paisa,variant FROM order_items WHERE seller_order_id=?').all(o.id).map(i => ({ name_bn: i.product_name_bn, quantity: i.quantity, unit_price_bdt: bdt(i.unit_price_paisa), variant: i.variant })),
    shipment: q('SELECT id,provider,tracking_id,status FROM shipments WHERE seller_order_id=? ORDER BY created_at DESC LIMIT 1').get(o.id) || null,
    history: q('SELECT status,note,created_at FROM order_events WHERE seller_order_id=? ORDER BY created_at,rowid').all(o.id)
  });
  const SO_SQL = `SELECT so.*,o.delivery_name,o.delivery_phone,o.delivery_address,o.delivery_area,o.customer_note,o.payment_method,o.payment_status,u.name customer_name,u.phone customer_phone
    FROM seller_orders so JOIN orders o ON o.id=so.order_id JOIN users u ON u.id=o.user_id WHERE so.seller_id=? AND so.status<>'AWAITING_PAYMENT'`;
  route('GET', '/api/v1/seller/orders', S, ({ user, url }) => {
    const st = url.searchParams.get('status');
    return ok(q(SO_SQL + (st ? ' AND so.status=?' : '') + ' ORDER BY so.created_at DESC,so.rowid DESC LIMIT 200').all(...(st ? [user.id, st] : [user.id])).map(subView));
  });
  route('GET', '/api/v1/seller/orders/:id', S, ({ user, params }) => {
    const o = q(SO_SQL + ' AND so.id=?').get(user.id, params[0]); if (!o) throw new HttpError(404, 'Seller order not found'); return ok(subView(o));
  });
  route('POST', '/api/v1/seller/orders/:id/status', S, ({ user, params, body }) => {
    const next = String(body.status || '');
    if (!['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(next)) throw bad('Invalid seller order status');
    return tx(() => {
      const so = q('SELECT * FROM seller_orders WHERE id=? AND seller_id=?').get(params[0], user.id);
      if (!so) throw new HttpError(404, 'Seller order not found');
      const parent = applySellerStatus(so, next, user.id, text(body.note, 300, 'নোট', { required: false }));
      return ok({ id: so.id, status: next, parent_status: parent });
    });
  });
  route('GET', '/api/v1/seller/courier/quote', S, ({ url }) => ok(Object.fromEntries(COURIERS.map(c => [c, bdt(courierQuote(c, url.searchParams.get('area') || ''))]))));
  route('POST', '/api/v1/seller/orders/:id/courier', S, ({ user, params, body }) => {
    const provider = String(body.provider || '').toUpperCase();
    return ok(tx(() => {
      const so = q('SELECT so.*,o.delivery_area FROM seller_orders so JOIN orders o ON o.id=so.order_id WHERE so.id=? AND so.seller_id=?').get(params[0], user.id);
      if (!so) throw new HttpError(404, 'Seller order not found');
      if (!['PROCESSING', 'SHIPPED'].includes(so.status)) throw new HttpError(409, 'অর্ডার PROCESSING বা SHIPPED অবস্থায় থাকতে হবে');
      if (q("SELECT 1 FROM shipments WHERE seller_order_id=? AND status NOT IN('FAILED_DELIVERY','RETURNED')").get(so.id)) throw new HttpError(409, 'ইতিমধ্যে কুরিয়ার বুক করা আছে');
      return bookShipment(so, provider, so.delivery_area, user.id);
    }), 201);
  });
  route('POST', '/api/v1/seller/shipments/:id/status', S, ({ user, params, body }) => {
    const sh = q('SELECT sh.* FROM shipments sh JOIN seller_orders so ON so.id=sh.seller_order_id WHERE sh.id=? AND so.seller_id=?').get(params[0], user.id);
    if (!sh) throw new HttpError(404, 'Shipment not found'); updateShipment(sh, String(body.status || ''), user.id); return ok({ id: sh.id, status: body.status });
  });

  // ----- finance -----
  route('GET', '/api/v1/seller/finance', S, ({ user }) => {
    const { available_paisa, ...b } = sellerBalance(user.id);
    return ok({ ...b,
      settlements: q("SELECT t.kind,t.amount_paisa,t.created_at,t.seller_order_id FROM transactions t WHERE t.seller_id=? ORDER BY t.created_at DESC,t.rowid DESC LIMIT 100").all(user.id).map(t => ({ kind: t.kind, amount_bdt: bdt(t.amount_paisa), created_at: t.created_at, seller_order_id: t.seller_order_id })),
      payouts: q('SELECT id,amount_paisa,method,account,status,note,created_at,decided_at FROM payouts WHERE seller_id=? ORDER BY created_at DESC').all(user.id).map(p => ({ id: p.id, amount_bdt: bdt(p.amount_paisa), method: p.method, account: p.account, status: p.status, note: p.note, created_at: p.created_at, decided_at: p.decided_at })) });
  });
  route('POST', '/api/v1/seller/payouts', S, ({ user, body }) => {
    const amount = money(body.amount_bdt, 'পরিমাণ'), method = String(body.method || '').toUpperCase();
    if (!['BKASH', 'NAGAD', 'ROCKET', 'BANK'].includes(method)) throw bad('পেআউট পদ্ধতি সঠিক নয়');
    const account = text(body.account, 100, 'অ্যাকাউন্ট নম্বর'); const pid = id();
    tx(() => {
      if (profile(user).status !== 'APPROVED') throw new HttpError(403, 'অনুমোদিত বিক্রেতারাই পেআউট চাইতে পারবেন');
      if (amount > sellerBalance(user.id).available_paisa) throw new HttpError(409, 'পর্যাপ্ত Available Balance নেই');
      q('INSERT INTO payouts VALUES(?,?,?,?,?,?,?,?,NULL)').run(pid, user.id, amount, method, account, 'REQUESTED', '', now());
      audit(user.id, 'PAYOUT_REQUEST', 'payout', pid, { amount });
      for (const a of q("SELECT id FROM users WHERE role='ADMIN'").all()) notify(a.id, 'নতুন পেআউট অনুরোধ', bdt(amount) + ' টাকা');
    });
    return ok({ id: pid, status: 'REQUESTED' }, 201);
  });
}
