import { randomBytes, randomInt } from 'node:crypto';
import { config, q, db, tx, id, now, sha256, hashPassword, verifyPassword, safeEq, normPhone, validPhone, validEmail, checkPassword, text, bad, HttpError, audit, notify, bdt } from './core.mjs';
import { shippingFor } from './gateways.mjs';

export const productView = r => ({ ...r, price_bdt: r.price_paisa / 100, sale_price_bdt: (r.discount_paisa && r.discount_paisa < r.price_paisa ? r.discount_paisa : r.price_paisa) / 100, discount_price_bdt: r.discount_paisa ? r.discount_paisa / 100 : null, in_stock: r.stock > 0 });
export const LIVE = "p.active=1 AND p.status='ACTIVE' AND EXISTS(SELECT 1 FROM seller_profiles sp WHERE sp.user_id=p.seller_id AND sp.status='APPROVED')";

export function newSession(userId) {
  const token = randomBytes(32).toString('hex');
  q('INSERT INTO sessions VALUES(?,?,?,?)').run(sha256(token), userId, new Date(Date.now() + config.sessionDays * 864e5).toISOString(), now());
  return token;
}
export function issueOtp(userId, purpose) {
  const code = String(randomInt(100000, 1000000));
  q('UPDATE otp_codes SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL').run(now(), userId, purpose);
  q('INSERT INTO otp_codes VALUES(?,?,?,?,0,?,NULL,?)').run(id(), userId, purpose, sha256(code + userId), new Date(Date.now() + 15 * 60000).toISOString(), now());
  if (!config.exposeDevCodes) console.warn('[otp] SMS/email provider not configured; code for', purpose, 'was not delivered');
  return code;
}
export function checkOtp(userId, purpose, code) {
  const row = q('SELECT * FROM otp_codes WHERE user_id=? AND purpose=? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1').get(userId, purpose);
  if (!row || row.expires_at < now() || row.attempts >= 5) throw bad('কোড মেয়াদোত্তীর্ণ বা অবৈধ');
  q('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
  if (!safeEq(sha256(String(code || '') + userId), row.code_hash)) throw bad('কোড সঠিক নয়');
  q('UPDATE otp_codes SET used_at=? WHERE id=?').run(now(), row.id);
}
const publicUser = u => ({ id: u.id, name: u.name, role: u.role, phone: u.phone, email: u.email || null, phone_verified: !!u.phone_verified, email_verified: !!u.email_verified });
function findByIdentifier(identifier) {
  const v = String(identifier || '').trim();
  return v.includes('@') ? q('SELECT * FROM users WHERE lower(email)=lower(?)').get(v) : q('SELECT * FROM users WHERE phone=?').get(normPhone(v));
}
function baseRegister(b, role) {
  const name = text(b.name, 100, 'নাম'), phone = normPhone(b.phone), email = text(b.email, 160, 'ইমেইল', { required: role === 'SELLER' }).toLowerCase();
  if (!validPhone(phone)) throw bad('সঠিক বাংলাদেশি মোবাইল নম্বর দিন');
  if (email && !validEmail(email)) throw bad('সঠিক ইমেইল দিন');
  checkPassword(b.password);
  if (b.confirm_password !== undefined && b.confirm_password !== b.password) throw bad('পাসওয়ার্ড মিলছে না');
  if (q('SELECT 1 FROM users WHERE phone=?').get(phone)) throw new HttpError(409, 'এই মোবাইল নম্বর দিয়ে আগেই অ্যাকাউন্ট আছে');
  if (email && q('SELECT 1 FROM users WHERE lower(email)=?').get(email)) throw new HttpError(409, 'এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট আছে');
  const uid = id();
  q('INSERT INTO users(id,phone,email,name,password,role,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(uid, phone, email || null, name, hashPassword(b.password), role, 'ACTIVE', now());
  return { uid, name, phone, email };
}

export function createSqliteCatalogRepository() {
  return Object.freeze({
    async listCategories() {
      return q('SELECT slug,name_bn,name_en FROM categories ORDER BY name_bn').all();
    },
    async listBrands() {
      return q('SELECT slug,name FROM brands ORDER BY name').all();
    },
    async listProducts(params = new URLSearchParams()) {
      const get = k => (params && typeof params.get === 'function' ? params.get(k) : params?.[k] ?? null);
      const term = (get('q') || '').slice(0, 80);
      const where = [LIVE, '(p.name_bn LIKE ? OR p.name_en LIKE ?)'];
      const args = ['%' + term + '%', '%' + term + '%'];
      if (get('category')) { where.push('c.slug=?'); args.push(String(get('category'))); }
      if (get('brand')) { where.push('b.slug=?'); args.push(String(get('brand'))); }
      const eff = 'CASE WHEN p.discount_paisa IS NOT NULL AND p.discount_paisa>0 AND p.discount_paisa<p.price_paisa THEN p.discount_paisa ELSE p.price_paisa END';
      if (get('min_price') !== null && Number(get('min_price')) >= 0) { where.push(eff + '>=?'); args.push(Math.round(Number(get('min_price')) * 100)); }
      if (get('max_price') !== null && Number(get('max_price')) > 0) { where.push(eff + '<=?'); args.push(Math.round(Number(get('max_price')) * 100)); }
      const order = { price_asc: eff + ' ASC', price_desc: eff + ' DESC', newest: 'p.created_at DESC,p.id DESC' }[get('sort')] || 'p.name_bn';
      const limit = Math.min(Math.max(parseInt(get('limit'), 10) || 100, 1), 100);
      const offset = Math.max(parseInt(get('offset'), 10) || 0, 0);
      const rows = q(`SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,c.slug category_slug,b.name brand,
        (SELECT url FROM product_images i WHERE i.product_id=p.id ORDER BY position LIMIT 1) image
        FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
      return rows.map(productView);
    },
    async suggestProducts(params = new URLSearchParams()) {
      const get = k => (params && typeof params.get === 'function' ? params.get(k) : params?.[k] ?? null);
      const t = (get('q') || '').slice(0, 40);
      if (t.length < 1) return [];
      return q(`SELECT p.id,p.name_bn,p.name_en FROM products p WHERE ${LIVE} AND (p.name_bn LIKE ? OR p.name_en LIKE ?) ORDER BY p.name_bn LIMIT 8`).all('%' + t + '%', '%' + t + '%');
    },
    async getProduct(productId) {
      const p = q(`SELECT p.*,c.slug category_slug,b.name brand,sp.shop_name seller_shop FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id WHERE p.id=? AND ${LIVE}`).get(String(productId));
      if (!p) return null;
      const { seller_id, password, ...rest } = p;
      const rv = q('SELECT COALESCE(AVG(rating),0) a,COUNT(*) n FROM reviews WHERE product_id=?').get(p.id) || { a: 0, n: 0 };
      let variants = [];
      try {
        const parsed = JSON.parse(p.variants || '[]');
        if (Array.isArray(parsed)) variants = parsed;
      } catch {}
      return {
        ...productView(rest),
        variants,
        images: q('SELECT url FROM product_images WHERE product_id=? ORDER BY position').all(p.id).map(i => i.url),
        rating: Math.round(Number(rv.a || 0) * 10) / 10,
        review_count: Number(rv.n || 0)
      };
    },
    async listReviews(productId) {
      return q('SELECT r.rating,r.comment,r.created_at,u.name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=? ORDER BY r.created_at DESC LIMIT 50').all(String(productId));
    }
  });
}

export default function register(route, ok, { catalogRepository } = {}) {
  const catalog = catalogRepository || createSqliteCatalogRepository();
  route('GET', '/health', null, () => { q('SELECT 1').get(); return { status: 200, body: { ok: true, service: 'marketplace-api', db: 'ok', payment_mode: config.paymentMode } }; });
  route('GET', '/api/v1/categories', null, async () => ok(await catalog.listCategories()));
  route('GET', '/api/v1/brands', null, async () => ok(await catalog.listBrands()));

  route('GET', '/api/v1/products', null, async ({ url }) => {
    return ok(await catalog.listProducts(url.searchParams));
  });
  route('GET', '/api/v1/products/suggest', null, async ({ url }) => {
    return ok(await catalog.suggestProducts(url.searchParams));
  });
  route('GET', '/api/v1/products/:id', null, async ({ params }) => {
    const product = await catalog.getProduct(params[0]);
    if (!product) throw new HttpError(404, 'Product not found');
    return ok(product);
  });
  route('GET', '/api/v1/products/:id/reviews', null, async ({ params }) =>
    ok(await catalog.listReviews(params[0])));
  route('GET', '/api/v1/shipping/quote', null, ({ url }) => {
    const sub = Math.round(Number(url.searchParams.get('subtotal_bdt') || 0) * 100);
    return ok({ shipping_bdt: bdt(shippingFor(url.searchParams.get('area') || '', sub)) });
  });

  // ---------- auth ----------
  route('POST', '/api/v1/auth/register', null, ({ body }) => {
    const r = tx(() => {
      const u = baseRegister(body, 'CUSTOMER');
      const addr = text(body.address, 500, 'ঠিকানা', { required: false });
      if (addr) q('INSERT INTO addresses VALUES(?,?,?,?,?,?,?,1)').run(id(), u.uid, 'Home', u.name, u.phone, addr, text(body.area, 100, 'এলাকা', { required: false }) || '—');
      audit(u.uid, 'CUSTOMER_REGISTER', 'user', u.uid);
      return u;
    });
    const out = { token: newSession(r.uid), data: { id: r.uid, name: r.name, role: 'CUSTOMER', phone: r.phone } };
    if (config.exposeDevCodes) out.dev_verification_code = issueOtp(r.uid, 'PHONE');
    return { status: 201, body: out };
  });
  route('POST', '/api/v1/auth/register-seller', null, ({ body }) => {
    const shop = text(body.shop_name, 100, 'দোকানের নাম'), shopAddr = text(body.shop_address, 300, 'দোকানের ঠিকানা'), biz = text(body.business_info, 1000, 'ব্যবসার তথ্য'), nid = text(body.kyc_nid, 30, 'NID নম্বর');
    if (!/^\d{10,17}$/.test(nid)) throw bad('সঠিক NID নম্বর দিন');
    const r = tx(() => {
      if (q('SELECT 1 FROM seller_profiles WHERE lower(shop_name)=lower(?)').get(shop)) throw new HttpError(409, 'এই দোকানের নাম আগেই নেওয়া হয়েছে');
      const u = baseRegister(body, 'SELLER');
      q('INSERT INTO seller_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(u.uid, shop, shopAddr, biz, nid, text(body.kyc_trade_license, 60, 'ট্রেড লাইসেন্স', { required: false }), 'PENDING', 800, now());
      audit(u.uid, 'SELLER_REGISTER', 'seller', u.uid, { shop });
      for (const a of q("SELECT id FROM users WHERE role='ADMIN'").all()) notify(a.id, 'নতুন বিক্রেতা আবেদন', shop);
      return u;
    });
    return { status: 201, body: { token: newSession(r.uid), data: { id: r.uid, name: r.name, role: 'SELLER', status: 'PENDING', message: 'অ্যাডমিন অনুমোদনের আগে পণ্য পাবলিক স্টোরফ্রন্টে দেখা যাবে না' } } };
  });
  route('POST', '/api/v1/auth/login', null, ({ body }) => {
    const user = findByIdentifier(body.identifier ?? body.phone);
    const good = verifyPassword(body.password, user && user.password);
    if (!user || !good) throw new HttpError(401, 'Invalid phone or password');
    if (body.portal && String(body.portal).toUpperCase() !== user.role) throw new HttpError(403, 'এই পোর্টালে লগইন অনুমোদিত নয়');
    if (user.status !== 'ACTIVE') throw new HttpError(403, 'আপনার অ্যাকাউন্ট সাময়িকভাবে বন্ধ আছে');
    audit(user.id, 'LOGIN', 'user', user.id);
    return { status: 200, body: { token: newSession(user.id), data: publicUser(user) } };
  });
  route('POST', '/api/v1/auth/logout', 'AUTH', ({ user }) => { q('DELETE FROM sessions WHERE token_hash=?').run(user.token_hash); return ok({ loggedOut: true }); });
  route('GET', '/api/v1/auth/me', 'AUTH', ({ user }) => {
    const sp = user.role === 'SELLER' ? q('SELECT shop_name,status FROM seller_profiles WHERE user_id=?').get(user.id) : null;
    return ok({ ...publicUser(user), seller: sp });
  });
  route('PATCH', '/api/v1/me', 'AUTH', ({ user, body }) => {
    const name = body.name !== undefined ? text(body.name, 100, 'নাম') : user.name;
    let { phone, email } = user;
    if (body.phone !== undefined) { phone = normPhone(body.phone); if (!validPhone(phone)) throw bad('সঠিক মোবাইল নম্বর দিন'); }
    if (body.email !== undefined) { email = text(body.email, 160, 'ইমেইল', { required: false }).toLowerCase() || null; if (email && !validEmail(email)) throw bad('সঠিক ইমেইল দিন'); }
    if (phone !== user.phone && q('SELECT 1 FROM users WHERE phone=? AND id<>?').get(phone, user.id)) throw new HttpError(409, 'এই মোবাইল নম্বর ব্যবহৃত');
    if (email && email !== user.email && q('SELECT 1 FROM users WHERE lower(email)=? AND id<>?').get(email, user.id)) throw new HttpError(409, 'এই ইমেইল ব্যবহৃত');
    q('UPDATE users SET name=?,phone=?,email=?,phone_verified=?,email_verified=? WHERE id=?').run(name, phone, email, phone === user.phone ? user.phone_verified : 0, email === user.email ? user.email_verified : 0, user.id);
    return ok({ ...publicUser(q('SELECT * FROM users WHERE id=?').get(user.id)) });
  });
  route('POST', '/api/v1/auth/change-password', 'AUTH', ({ user, body }) => {
    const row = q('SELECT password FROM users WHERE id=?').get(user.id);
    if (!verifyPassword(body.current_password, row.password)) throw new HttpError(403, 'বর্তমান পাসওয়ার্ড সঠিক নয়');
    checkPassword(body.new_password);
    tx(() => { q('UPDATE users SET password=? WHERE id=?').run(hashPassword(body.new_password), user.id); q('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id, user.token_hash); audit(user.id, 'PASSWORD_CHANGE', 'user', user.id); });
    return ok({ changed: true });
  });
  route('POST', '/api/v1/auth/forgot-password', null, ({ body }) => {
    const u = findByIdentifier(body.identifier);
    const out = { message: 'যদি অ্যাকাউন্টটি থাকে, একটি রিসেট কোড পাঠানো হয়েছে' };
    if (u && u.status === 'ACTIVE') { const code = issueOtp(u.id, 'RESET'); if (config.exposeDevCodes) out.dev_code = code; }
    return ok(out);
  });
  route('POST', '/api/v1/auth/reset-password', null, ({ body }) => {
    const u = findByIdentifier(body.identifier);
    if (!u) throw bad('কোড মেয়াদোত্তীর্ণ বা অবৈধ');
    checkPassword(body.new_password);
    tx(() => { checkOtp(u.id, 'RESET', body.code); q('UPDATE users SET password=? WHERE id=?').run(hashPassword(body.new_password), u.id); q('DELETE FROM sessions WHERE user_id=?').run(u.id); audit(u.id, 'PASSWORD_RESET', 'user', u.id); });
    return ok({ reset: true });
  });
  route('POST', '/api/v1/auth/send-verification', 'AUTH', ({ user, body }) => {
    const purpose = body.purpose === 'EMAIL' ? 'EMAIL' : 'PHONE';
    if (purpose === 'EMAIL' && !user.email) throw bad('আগে ইমেইল যোগ করুন');
    const code = issueOtp(user.id, purpose);
    return ok({ sent: true, ...(config.exposeDevCodes ? { dev_code: code } : {}) });
  });
  route('POST', '/api/v1/auth/verify', 'AUTH', ({ user, body }) => {
    const purpose = body.purpose === 'EMAIL' ? 'EMAIL' : 'PHONE';
    tx(() => { checkOtp(user.id, purpose, body.code); q(`UPDATE users SET ${purpose === 'EMAIL' ? 'email_verified' : 'phone_verified'}=1 WHERE id=?`).run(user.id); });
    return ok({ verified: purpose });
  });

  route('GET', '/api/v1/notifications', 'AUTH', ({ user }) => ok(q('SELECT id,title,body,read,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(user.id)));
  route('POST', '/api/v1/notifications/read', 'AUTH', ({ user }) => { q('UPDATE notifications SET read=1 WHERE user_id=?').run(user.id); return ok({ read: true }); });
}
