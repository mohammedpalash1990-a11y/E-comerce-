import { randomUUID } from 'node:crypto';
import { HttpError, text, now as defaultNow } from './postgres-shared.mjs';

const MAX_STOCK = 1_000_000;
const MAX_IMAGES = 6;
const priceToPaisa = value => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw new HttpError(400, 'পণ্যের মূল্য সঠিক নয়');
  const paisa = Math.round(amount * 100);
  if (!Number.isSafeInteger(paisa) || paisa <= 0) throw new HttpError(400, 'পণ্যের মূল্য সঠিক নয়');
  return paisa;
};
function imagesFrom(body) {
  if (body.images === undefined) return null;
  if (!Array.isArray(body.images) || body.images.length > MAX_IMAGES) throw new HttpError(400, 'সর্বোচ্চ ৬টি ছবি দেওয়া যাবে');
  return body.images.map(value => {
    const url = String(value || '').trim();
    if (url.length > 500 || !/^https:\/\/[^\s"'<>]+$/i.test(url)) throw new HttpError(400, 'প্রতিটি ছবির জন্য সঠিক HTTPS লিংক দিতে হবে');
    return url;
  });
}
function variantsFrom(body) {
  if (body.variants === undefined) return null;
  if (!Array.isArray(body.variants) || body.variants.length > 30) throw new HttpError(400, 'ভ্যারিয়েন্ট তালিকা সঠিক নয়');
  return JSON.stringify(body.variants.map(item => ({
    label: text(item?.label, 60, 'ভ্যারিয়েন্টের নাম'),
    sku: text(item?.sku, 40, 'ভ্যারিয়েন্ট SKU', { required: false })
  })));
}
function productFields(body, { partial = false } = {}) {
  const fields = {};
  const put = (key, value) => { if (value !== undefined) fields[key] = value; };
  if (!partial || body.name_bn !== undefined) put('name_bn', text(body.name_bn, 160, 'বাংলা নাম'));
  if (!partial || body.name_en !== undefined) put('name_en', text(body.name_en, 160, 'ইংরেজি নাম'));
  if (!partial || body.price_bdt !== undefined) put('price_paisa', priceToPaisa(body.price_bdt));
  if (body.discount_price_bdt !== undefined) put('discount_paisa', body.discount_price_bdt === null || body.discount_price_bdt === '' ? null : priceToPaisa(body.discount_price_bdt));
  const price = fields.price_paisa;
  const discount = fields.discount_paisa;
  if (discount != null && (discount <= 0 || (price !== undefined && discount >= price))) throw new HttpError(400, 'ডিসকাউন্ট মূল্য মূল্যের চেয়ে কম হতে হবে');
  if (!partial || body.stock !== undefined) {
    const stock = Number(body.stock);
    if (!Number.isSafeInteger(stock) || stock < 0 || stock > MAX_STOCK) throw new HttpError(400, 'স্টক সঠিক নয়');
    put('stock', stock);
  }
  if (body.description !== undefined) put('description', text(body.description, 5000, 'বিবরণ', { required: false }));
  if (body.sku !== undefined) put('sku', text(body.sku, 40, 'SKU', { required: false }) || null);
  if (!partial || body.category_slug !== undefined) put('category_id', '__CATEGORY__');
  if (body.brand_slug !== undefined) put('brand_id', body.brand_slug ? '__BRAND__' : null);
  const variants = variantsFrom(body);
  if (variants !== null) put('variants', variants);
  return fields;
}

export function registerPostgresSellerProductRoutes(route, ok, { database, id = randomUUID, now = defaultNow } = {}) {
  if (!database?.q || !database?.tx) throw new TypeError('PostgreSQL database is required');
  const q = sql => database.q(sql);
  async function sellerProfile(userId) {
    const profile = await q('SELECT sp.status,u.status AS account_status FROM seller_profiles sp JOIN users u ON u.id=sp.user_id WHERE sp.user_id=?').get(userId);
    if (!profile) throw new HttpError(403, 'বিক্রেতা প্রোফাইল পাওয়া যায়নি');
    if (profile.account_status !== 'ACTIVE' || !['PENDING', 'APPROVED'].includes(profile.status)) throw new HttpError(403, 'আপনার বিক্রেতা অ্যাকাউন্টে পণ্য পরিবর্তনের অনুমতি নেই');
    return profile;
  }
  async function resolveFields(body, options) {
    const fields = productFields(body, options);
    if (fields.category_id === '__CATEGORY__') {
      const category = await q('SELECT id FROM categories WHERE slug=?').get(String(body.category_slug || ''));
      if (!category) throw new HttpError(400, 'ক্যাটাগরি সঠিক নয়');
      fields.category_id = category.id;
    }
    if (fields.brand_id === '__BRAND__') {
      const brand = await q('SELECT id FROM brands WHERE slug=?').get(String(body.brand_slug));
      if (!brand) throw new HttpError(400, 'ব্র্যান্ড সঠিক নয়');
      fields.brand_id = brand.id;
    }
    const existing = options.partial ? options.existing : null;
    if (existing && fields.discount_paisa !== undefined && fields.discount_paisa !== null) {
      const effectivePrice = fields.price_paisa ?? Number(existing.price_paisa);
      if (fields.discount_paisa >= effectivePrice) throw new HttpError(400, 'ডিসকাউন্ট মূল্য মূল্যের চেয়ে কম হতে হবে');
    }
    if (existing && fields.price_paisa !== undefined && fields.discount_paisa === undefined && existing.discount_paisa != null && Number(existing.discount_paisa) >= fields.price_paisa) {
      fields.discount_paisa = null;
    }
    return fields;
  }
  async function saveImages(productId, images) {
    if (images === null) return;
    await q('DELETE FROM product_images WHERE product_id=?').run(productId);
    for (let position = 0; position < images.length; position++) {
      await q('INSERT INTO product_images(id,product_id,url,position) VALUES(?,?,?,?)').run(id(), productId, images[position], position);
    }
  }
  async function productOwned(productId, sellerId) {
    const product = await q("SELECT * FROM products WHERE id=? AND seller_id=? AND status<>'ARCHIVED'").get(productId, sellerId);
    if (!product) throw new HttpError(404, 'পণ্যটি পাওয়া যায়নি');
    return product;
  }
  const view = row => ({
    id: row.id, name_bn: row.name_bn, name_en: row.name_en, price_paisa: Number(row.price_paisa),
    price_bdt: Number(row.price_paisa) / 100, discount_paisa: row.discount_paisa == null ? null : Number(row.discount_paisa),
    discount_price_bdt: row.discount_paisa == null ? null : Number(row.discount_paisa) / 100,
    stock: Number(row.stock), status: row.status, sku: row.sku, category_slug: row.category_slug,
    description: row.description, active: Boolean(row.active), image: row.image || null, updated_at: row.updated_at
  });

  route('GET', '/api/v1/seller/products', ['SELLER'], async ({ user, url }) => {
    const status = String(url.searchParams.get('status') || '').toUpperCase();
    const allowed = ['PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'ARCHIVED'];
    const filter = allowed.includes(status) ? ' AND p.status=?' : '';
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 100);
    const offset = Math.max(Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
    const rows = await q(`SELECT p.*,c.slug AS category_slug,
      (SELECT i.url FROM product_images i WHERE i.product_id=p.id ORDER BY i.position LIMIT 1) AS image
      FROM products p LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.seller_id=? AND p.status<>'ARCHIVED'${filter}
      ORDER BY p.updated_at DESC,p.id DESC LIMIT ? OFFSET ?`).all(...(filter ? [user.id, status, limit, offset] : [user.id, limit, offset]));
    return ok(rows.map(view));
  });
  route('GET', '/api/v1/seller/products/:id', ['SELLER'], async ({ user, params }) => {
    const product = await productOwned(params[0], user.id);
    const [category, images] = await Promise.all([
      q('SELECT slug FROM categories WHERE id=?').get(product.category_id),
      q('SELECT url FROM product_images WHERE product_id=? ORDER BY position').all(product.id)
    ]);
    let variants = [];
    try { const parsed = JSON.parse(product.variants || '[]'); if (Array.isArray(parsed)) variants = parsed; } catch {}
    return ok({ ...view({ ...product, category_slug: category?.slug }), variants, images: images.map(item => item.url) });
  });
  route('POST', '/api/v1/seller/products', ['SELLER'], async ({ user, body }) => {
    await sellerProfile(user.id);
    const images = imagesFrom(body), fields = await resolveFields(body, { partial: false });
    const productId = id(), timestamp = now();
    await database.tx(async () => {
      await q(`INSERT INTO products(id,category_id,name_bn,name_en,price_paisa,stock,active,seller_id,status,description,discount_paisa,sku,variants,brand_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,0,?,'PENDING_REVIEW',?,?,?,?,?,?,?)`).run(
        productId, fields.category_id, fields.name_bn, fields.name_en, fields.price_paisa, fields.stock, user.id,
        fields.description || '', fields.discount_paisa ?? null, fields.sku ?? null, fields.variants || '[]',
        fields.brand_id ?? null, timestamp, timestamp
      );
      await saveImages(productId, images);
      await q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id(), user.id, 'PRODUCT_SUBMIT', 'product', productId, JSON.stringify({ status: 'PENDING_REVIEW' }), timestamp);
    });
    return ok({ id: productId, status: 'PENDING_REVIEW', message: 'পণ্যটি অ্যাডমিন অনুমোদনের অপেক্ষায় আছে' }, 201);
  }, { limit: 3000000 });
  route('PUT', '/api/v1/seller/products/:id', ['SELLER'], async ({ user, params, body }) => {
    await sellerProfile(user.id);
    const product = await productOwned(params[0], user.id);
    const images = imagesFrom(body), fields = await resolveFields(body, { partial: true, existing: product });
    const keys = Object.keys(fields);
    if (!keys.length && images === null) throw new HttpError(400, 'পরিবর্তনের জন্য অন্তত একটি তথ্য দিতে হবে');
    const timestamp = now();
    await database.tx(async () => {
      if (keys.length) await q('UPDATE products SET ' + keys.map(key => key + '=?').join(',') + ",status='PENDING_REVIEW',active=0,updated_at=? WHERE id=? AND seller_id=?")
        .run(...keys.map(key => fields[key]), timestamp, product.id, user.id);
      else await q("UPDATE products SET status='PENDING_REVIEW',active=0,updated_at=? WHERE id=? AND seller_id=?").run(timestamp, product.id, user.id);
      await saveImages(product.id, images);
      await q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id(), user.id, 'PRODUCT_EDIT_SUBMITTED', 'product', product.id, JSON.stringify({ fields: keys, status: 'PENDING_REVIEW' }), timestamp);
    });
    return ok({ id: product.id, status: 'PENDING_REVIEW', message: 'পরিবর্তনটি পুনরায় অনুমোদনের জন্য পাঠানো হয়েছে' });
  }, { limit: 3000000 });
  route('DELETE', '/api/v1/seller/products/:id', ['SELLER'], async ({ user, params }) => {
    await sellerProfile(user.id);
    const product = await productOwned(params[0], user.id);
    const timestamp = now();
    await database.tx(async () => {
      await q("UPDATE products SET status='ARCHIVED',active=0,updated_at=? WHERE id=? AND seller_id=?").run(timestamp, product.id, user.id);
      await q('DELETE FROM cart_items WHERE product_id=?').run(product.id);
      await q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id(), user.id, 'PRODUCT_ARCHIVE', 'product', product.id, JSON.stringify({ previous_status: product.status }), timestamp);
    });
    return ok({ id: product.id, archived: true });
  });
}
