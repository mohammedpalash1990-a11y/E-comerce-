import { q, tx, id, now, audit, notify, text, bad, HttpError, normPhone, validPhone, bdt, orderNo } from './core.mjs';
import { PAYMENT_METHODS, shippingFor, initiateGateway } from './gateways.mjs';
import { applyParentStatus, orderView, addEvent } from './orders.mjs';
import { productView, LIVE } from './routes_public.mjs';

const effPrice = p => (p.discount_paisa && p.discount_paisa < p.price_paisa ? p.discount_paisa : p.price_paisa);
const C = ['CUSTOMER'];

export function startPayment(order, method) {
  const pay = { id: id() };
  const g = initiateGateway(method, pay);
  const existing = q("SELECT id FROM payments WHERE order_id=? AND status IN('INITIATED','PENDING')").all(order.id);
  for (const e of existing) q("UPDATE payments SET status='SUPERSEDED',updated_at=? WHERE id=?").run(now(), e.id);
  q('INSERT INTO payments VALUES(?,?,?,?,?,?,?,?,?)').run(pay.id, order.id, method, order.total_paisa, 'INITIATED', g.gatewayTxnId, JSON.stringify({ sandbox: g.sandbox }), now(), now());
  q('UPDATE orders SET payment_method=? WHERE id=?').run(method, order.id);
  return { payment_id: pay.id, method, status: 'INITIATED', gateway_txn_id: g.gatewayTxnId, redirect_url: g.redirectUrl, sandbox: !!g.sandbox };
}

function loadCartLines(userId) {
  return q(`SELECT ci.product_id,ci.quantity,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,
    (SELECT url FROM product_images i WHERE i.product_id=p.id ORDER BY position LIMIT 1) image
    FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.user_id=? AND ${LIVE}`).all(userId);
}
function couponFor(code, subtotal) {
  if (!code) return null;
  const c = q('SELECT * FROM coupons WHERE code=? AND active=1').get(String(code).trim().toUpperCase());
  if (!c || (c.expires_at && c.expires_at < now()) || (c.max_uses !== null && c.used_count >= c.max_uses)) throw bad('কুপন কোডটি বৈধ নয়');
  if (subtotal < c.min_order_paisa) throw bad('কুপনের জন্য ন্যূনতম অর্ডার ' + bdt(c.min_order_paisa) + ' টাকা');
  const discount = c.type === 'PERCENT' ? Math.floor(subtotal * c.value / 100) : c.value;
  return { code: c.code, discount: Math.min(discount, subtotal) };
}

export default function register(route, ok) {
  // ----- addresses -----
  const addrBody = (b, u) => {
    const phone = normPhone(b.phone); if (!validPhone(phone)) throw bad('সঠিক মোবাইল নম্বর দিন');
    return [text(b.label, 40, 'লেবেল', { required: false }), text(b.name || u.name, 100, 'নাম'), phone, text(b.address, 500, 'ঠিকানা'), text(b.area, 100, 'এলাকা')];
  };
  route('GET', '/api/v1/customer/addresses', C, ({ user }) => ok(q('SELECT id,label,name,phone,address,area,is_default FROM addresses WHERE user_id=? ORDER BY is_default DESC,rowid').all(user.id)));
  route('POST', '/api/v1/customer/addresses', C, ({ user, body }) => {
    const a = addrBody(body, user), n = q('SELECT COUNT(*) n FROM addresses WHERE user_id=?').get(user.id).n;
    if (n >= 10) throw bad('সর্বোচ্চ ১০টি ঠিকানা সংরক্ষণ করা যায়');
    const aid = id(); tx(() => { const def = body.is_default || n === 0 ? 1 : 0; if (def) q('UPDATE addresses SET is_default=0 WHERE user_id=?').run(user.id); q('INSERT INTO addresses VALUES(?,?,?,?,?,?,?,?)').run(aid, user.id, ...a, def); });
    return ok({ id: aid }, 201);
  });
  route('PUT', '/api/v1/customer/addresses/:id', C, ({ user, params, body }) => {
    if (!q('SELECT 1 FROM addresses WHERE id=? AND user_id=?').get(params[0], user.id)) throw new HttpError(404, 'Address not found');
    const a = addrBody(body, user);
    tx(() => { if (body.is_default) q('UPDATE addresses SET is_default=0 WHERE user_id=?').run(user.id); q('UPDATE addresses SET label=?,name=?,phone=?,address=?,area=?,is_default=COALESCE(?,is_default) WHERE id=? AND user_id=?').run(...a, body.is_default ? 1 : null, params[0], user.id); });
    return ok({ id: params[0] });
  });
  route('DELETE', '/api/v1/customer/addresses/:id', C, ({ user, params }) => { q('DELETE FROM addresses WHERE id=? AND user_id=?').run(params[0], user.id); return ok({ deleted: true }); });

  // ----- wishlist -----
  route('GET', '/api/v1/customer/wishlist', C, ({ user }) => ok(q(`SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock FROM wishlists w JOIN products p ON p.id=w.product_id WHERE w.user_id=? AND ${LIVE} ORDER BY w.created_at DESC`).all(user.id).map(productView)));
  route('POST', '/api/v1/customer/wishlist', C, ({ user, body }) => {
    if (!q(`SELECT 1 FROM products p WHERE p.id=? AND ${LIVE}`).get(String(body.productId || ''))) throw new HttpError(404, 'Product not found');
    q('INSERT OR IGNORE INTO wishlists VALUES(?,?,?)').run(user.id, body.productId, now()); return ok({ added: true }, 201);
  });
  route('DELETE', '/api/v1/customer/wishlist/:pid', C, ({ user, params }) => { q('DELETE FROM wishlists WHERE user_id=? AND product_id=?').run(user.id, params[0]); return ok({ removed: true }); });

  // ----- cart (server side) -----
  const cartView = userId => { const lines = loadCartLines(userId).map(l => ({ product_id: l.product_id, name_bn: l.name_bn, name_en: l.name_en, quantity: l.quantity, stock: l.stock, image: l.image, unit_price_bdt: bdt(effPrice(l)), line_total_bdt: bdt(effPrice(l) * l.quantity), available: l.stock >= l.quantity }));
    return { items: lines, subtotal_bdt: lines.reduce((s, l) => s + l.line_total_bdt, 0) }; };
  route('GET', '/api/v1/customer/cart', C, ({ user }) => ok(cartView(user.id)));
  route('PUT', '/api/v1/customer/cart', C, ({ user, body }) => {
    const qty = Number(body.quantity);
    if (!Number.isInteger(qty) || qty < 0 || qty > 1000) throw bad('পরিমাণ সঠিক নয়');
    const p = q(`SELECT p.stock FROM products p WHERE p.id=? AND ${LIVE}`).get(String(body.productId || ''));
    if (!p) throw new HttpError(404, 'Product not found');
    if (qty === 0) q('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(user.id, body.productId);
    else { if (qty > p.stock) throw new HttpError(409, 'স্টকে যথেষ্ট পণ্য নেই'); q('INSERT INTO cart_items VALUES(?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=excluded.quantity').run(user.id, body.productId, qty); }
    return ok(cartView(user.id));
  });
  route('DELETE', '/api/v1/customer/cart/:pid', C, ({ user, params }) => { q('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(user.id, params[0]); return ok(cartView(user.id)); });
  route('DELETE', '/api/v1/customer/cart', C, ({ user }) => { q('DELETE FROM cart_items WHERE user_id=?').run(user.id); return ok(cartView(user.id)); });

  // ----- checkout -----
  route('POST', '/api/v1/coupons/validate', C, ({ body }) => {
    const sub = Math.round(Number(body.subtotal_bdt || 0) * 100); const c = couponFor(body.code, sub); return ok({ code: c.code, discount_bdt: bdt(c.discount) });
  });
  route('POST', '/api/v1/checkout', C, ({ user, body }) => {
    const d = body.delivery || {};
    const delivery = { name: String(d.name || '').trim(), phone: normPhone(d.phone), address: String(d.address || '').trim(), area: String(d.area || '').trim(), note: String(d.note || '').trim() };
    if (!delivery.name || delivery.name.length > 100 || !validPhone(delivery.phone) || !delivery.address || delivery.address.length > 500 || !delivery.area || delivery.area.length > 100 || delivery.note.length > 500) throw bad('নাম, সঠিক বাংলাদেশি মোবাইল, পূর্ণ ঠিকানা ও এলাকা দিতে হবে');
    const method = String(body.payment_method || 'COD').toUpperCase();
    if (!PAYMENT_METHODS.includes(method)) throw bad('অজানা পেমেন্ট পদ্ধতি');
    const fromCart = !Array.isArray(body.items);
    const raw = fromCart ? q('SELECT product_id productId,quantity FROM cart_items WHERE user_id=?').all(user.id) : body.items;
    if (!raw.length || raw.length > 50) throw bad('Cart must contain between 1 and 50 items');
    const quantities = new Map();
    for (const it of raw) { const n = Number(it.quantity); if (!Number.isInteger(n) || n < 1 || n > 1000 || !it.productId) throw bad('Invalid cart item'); quantities.set(String(it.productId), (quantities.get(String(it.productId)) || 0) + n); }
    const variants = new Map(raw.map(i => [String(i.productId), String(i.variant || '').slice(0, 60)]));
    const orderId = id();
    const result = tx(() => {
      const lines = []; let subtotal = 0;
      for (const [pid, qty] of quantities) {
        const p = q(`SELECT p.* FROM products p WHERE p.id=? AND ${LIVE}`).get(pid);
        if (!p || p.stock < qty) throw bad('Invalid item or insufficient stock');
        const unit = effPrice(p); subtotal += unit * qty;
        lines.push({ pid, qty, name: p.name_bn, unit, seller_id: p.seller_id, variant: variants.get(pid) });
      }
      const cpn = couponFor(body.coupon_code, subtotal);
      const shipping = shippingFor(delivery.area, subtotal), discount = cpn ? cpn.discount : 0;
      const total = subtotal + shipping - discount;
      if (!Number.isSafeInteger(total) || total < 0) throw bad('Order total is too large');
      for (const l of lines) if (q("UPDATE products SET stock=stock-? WHERE id=? AND stock>=? AND active=1 AND status='ACTIVE'").run(l.qty, l.pid, l.qty).changes !== 1) throw new HttpError(409, 'Stock changed; please refresh your cart');
      const online = method !== 'COD', initial = online ? 'AWAITING_PAYMENT' : 'CONFIRMED', ts = now();
      q('INSERT INTO orders(id,user_id,total_paisa,status,created_at,delivery_name,delivery_phone,delivery_address,delivery_area,customer_note,subtotal_paisa,shipping_paisa,discount_paisa,coupon_code,payment_method,payment_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(orderId, user.id, total, initial, ts, delivery.name, delivery.phone, delivery.address, delivery.area, delivery.note, subtotal, shipping, discount, cpn ? cpn.code : null, method, 'PENDING');
      if (cpn) { if (q('UPDATE coupons SET used_count=used_count+1 WHERE code=? AND (max_uses IS NULL OR used_count<max_uses)').run(cpn.code).changes !== 1) throw bad('কুপনের ব্যবহারসীমা শেষ'); }
      const groups = new Map(); for (const l of lines) (groups.get(l.seller_id) || groups.set(l.seller_id, []).get(l.seller_id)).push(l);
      for (const [sid, ls] of groups) {
        const sub = ls.reduce((s, l) => s + l.unit * l.qty, 0), bps = q('SELECT commission_bps b FROM seller_profiles WHERE user_id=?').get(sid)?.b ?? 800;
        const commission = Math.floor(sub * bps / 10000), soId = id();
        q('INSERT INTO seller_orders(id,order_id,seller_id,status,subtotal_paisa,created_at,commission_paisa,net_paisa) VALUES(?,?,?,?,?,?,?,?)').run(soId, orderId, sid, initial, sub, ts, commission, sub - commission);
        for (const l of ls) q('INSERT INTO order_items(id,order_id,product_id,product_name_bn,quantity,unit_price_paisa,seller_id,seller_order_id,variant) VALUES(?,?,?,?,?,?,?,?,?)').run(id(), orderId, l.pid, l.name, l.qty, l.unit, sid, soId, l.variant);
        if (!online) notify(sid, 'নতুন অর্ডার', orderNo(orderId));
      }
      q('INSERT INTO payments VALUES(?,?,?,?,?,?,?,?,?)').run(id(), orderId, method, total, 'PENDING', null, '{}', ts, ts);
      if (fromCart) q('DELETE FROM cart_items WHERE user_id=?').run(user.id); else for (const pid of quantities.keys()) q('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(user.id, pid);
      addEvent(orderId, null, initial, 'অর্ডার তৈরি', user.id);
      audit(user.id, 'CHECKOUT', 'order', orderId, { total, method });
      let payment = { method, status: 'PENDING' };
      if (online) { q("DELETE FROM payments WHERE order_id=? AND method=? AND status='PENDING'").run(orderId, method); payment = startPayment({ id: orderId, total_paisa: total }, method); }
      return { total, subtotal, shipping, discount, status: initial, payment };
    });
    return ok({ id: orderId, orderNumber: orderNo(orderId), total_bdt: bdt(result.total), subtotal_bdt: bdt(result.subtotal), shipping_bdt: bdt(result.shipping), discount_bdt: bdt(result.discount), status: result.status, payment: result.payment }, 201);
  });

  // ----- orders -----
  route('GET', '/api/v1/customer/orders', C, ({ user }) => ok(q('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC,rowid DESC').all(user.id).map(o => orderView(o))));
  const mine = (oid, uid) => { const o = q('SELECT * FROM orders WHERE id=? AND user_id=?').get(oid, uid); if (!o) throw new HttpError(404, 'Order not found'); return o; };
  route('GET', '/api/v1/customer/orders/:id', C, ({ user, params }) => {
    const o = mine(params[0], user.id);
    const subs = q('SELECT so.id,so.status,so.subtotal_paisa,sp.shop_name FROM seller_orders so LEFT JOIN seller_profiles sp ON sp.user_id=so.seller_id WHERE so.order_id=?').all(o.id).map(s => ({ id: s.id, shop: s.shop_name, status: s.status, subtotal_bdt: bdt(s.subtotal_paisa), shipment: q('SELECT provider,tracking_id,status FROM shipments WHERE seller_order_id=? ORDER BY created_at DESC LIMIT 1').get(s.id) || null }));
    return ok({ ...orderView(o), suborders: subs });
  });
  route('GET', '/api/v1/customer/orders/:id/tracking', C, ({ user, params }) => {
    const o = mine(params[0], user.id);
    return ok({ orderNumber: orderNo(o.id), status: o.status, events: q('SELECT status,note,created_at,seller_order_id FROM order_events WHERE order_id=? ORDER BY created_at,rowid').all(o.id),
      shipments: q('SELECT s.provider,s.tracking_id,s.status FROM shipments s JOIN seller_orders so ON so.id=s.seller_order_id WHERE so.order_id=?').all(o.id) });
  });
  route('POST', '/api/v1/customer/orders/:id/cancel', C, ({ user, params, body }) => {
    const o = mine(params[0], user.id);
    const status = applyParentStatus(o.id, 'CANCELLED', user.id, text(body.reason, 300, 'কারণ', { required: false }), { onlyIfAllCancellable: true });
    return ok({ id: o.id, status });
  });
  route('POST', '/api/v1/customer/orders/:id/pay', C, ({ user, params, body }) => {
    const o = mine(params[0], user.id);
    if (o.status !== 'AWAITING_PAYMENT' || o.payment_status === 'PAID') throw new HttpError(409, 'এই অর্ডারের পেমেন্ট প্রয়োজন নেই');
    const method = String(body.method || o.payment_method).toUpperCase();
    if (!PAYMENT_METHODS.includes(method) || method === 'COD') throw bad('অনলাইন পেমেন্ট পদ্ধতি দিন');
    return ok(tx(() => startPayment(o, method)));
  });

  // ----- reviews -----
  route('POST', '/api/v1/customer/products/:id/reviews', C, ({ user, params, body }) => {
    const rating = Number(body.rating); if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('রেটিং ১ থেকে ৫ হতে হবে');
    if (!q("SELECT 1 FROM order_items oi JOIN seller_orders so ON so.id=oi.seller_order_id JOIN orders o ON o.id=oi.order_id WHERE o.user_id=? AND oi.product_id=? AND so.status='DELIVERED'").get(user.id, params[0])) throw new HttpError(403, 'শুধু ডেলিভারি পাওয়া পণ্যের রিভিউ দেওয়া যায়');
    q('INSERT INTO reviews VALUES(?,?,?,?,?,?) ON CONFLICT(product_id,user_id) DO UPDATE SET rating=excluded.rating,comment=excluded.comment').run(id(), params[0], user.id, rating, text(body.comment, 1000, 'মন্তব্য', { required: false }), now());
    return ok({ saved: true }, 201);
  });
}
