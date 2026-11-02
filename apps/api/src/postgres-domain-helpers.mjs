import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = message => new HttpError(400, message);
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const normPhone = value => String(value || '').replace(/[\s-]/g, '').replace(/^\+?88/, '');
export const validPhone = value => /^01[3-9]\d{8}$/.test(value);
export function text(value, max, label, { required = true } = {}) {
  const clean = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !clean) throw bad(label + ' দিতে হবে');
  if (clean.length > max) throw bad(label + ' অনেক লম্বা');
  return clean;
}
export function money(value, label) {
  const amount = Number(value), paisa = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(paisa) || paisa > 1e11) throw bad(label + ' সঠিক নয়');
  return paisa;
}
export const productView = row => ({ ...row, price_bdt: row.price_paisa / 100, sale_price_bdt: (row.discount_paisa && row.discount_paisa < row.price_paisa ? row.discount_paisa : row.price_paisa) / 100, discount_price_bdt: row.discount_paisa ? row.discount_paisa / 100 : null, in_stock: row.stock > 0 });
export const LIVE = "p.active=1 AND p.status='ACTIVE' AND EXISTS(SELECT 1 FROM seller_profiles sp WHERE sp.user_id=p.seller_id AND sp.status='APPROVED')";

export function parseImages(list) {
  if (list === undefined) return null;
  if (!Array.isArray(list) || list.length > 6) throw bad('সর্বোচ্চ ৬টি ছবি দেওয়া যায়');
  return list.map(value => {
    const url = String(value);
    if (/^https:\/\/[^\s"'<>]+$/i.test(url) && url.length <= 500) return url;
    if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url) && url.length <= 400000) return url;
    throw bad('ছবি শুধু https লিংক বা ছোট PNG/JPEG/WebP হতে পারে');
  });
}

// PostgreSQL-only product field parser. Category and brand lookups are injected
// so this module never imports the SQLite application runtime.
export async function productFields(body, { partial = false, query }) {
  const fields = {};
  const set = (key, value) => { if (value !== undefined) fields[key] = value; };
  if (!partial || body.name_bn !== undefined) set('name_bn', text(body.name_bn, 160, 'বাংলা নাম'));
  if (!partial || body.name_en !== undefined) set('name_en', text(body.name_en, 160, 'ইংরেজি নাম'));
  if (!partial || body.price_bdt !== undefined) set('price_paisa', money(body.price_bdt, 'মূল্য'));
  if (body.discount_price_bdt !== undefined) set('discount_paisa', body.discount_price_bdt === null || body.discount_price_bdt === '' ? null : money(body.discount_price_bdt, 'ডিসকাউন্ট মূল্য'));
  if (fields.discount_paisa && fields.price_paisa && fields.discount_paisa >= fields.price_paisa) throw bad('ডিসকাউন্ট মূল্য মূল্যের চেয়ে কম হতে হবে');
  if (!partial || body.stock !== undefined) {
    const stock = Number(body.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) throw bad('স্টক সঠিক নয়');
    set('stock', stock);
  }
  if (body.description !== undefined) set('description', text(body.description, 5000, 'বিবরণ', { required: false }));
  if (body.sku !== undefined) set('sku', text(body.sku, 40, 'SKU', { required: false }) || null);
  if (body.category_slug !== undefined || !partial) {
    const category = await query('SELECT id FROM categories WHERE slug=?').get(String(body.category_slug || ''));
    if (!category) throw bad('ক্যাটাগরি সঠিক নয়');
    set('category_id', category.id);
  }
  if (body.brand_slug !== undefined) {
    if (!body.brand_slug) set('brand_id', null);
    else {
      const brand = await query('SELECT id FROM brands WHERE slug=?').get(String(body.brand_slug));
      if (!brand) throw bad('ব্র্যান্ড সঠিক নয়');
      set('brand_id', brand.id);
    }
  }
  if (body.variants !== undefined) {
    if (!Array.isArray(body.variants) || body.variants.length > 30) throw bad('ভ্যারিয়েন্ট তালিকা সঠিক নয়');
    set('variants', JSON.stringify(body.variants.map(item => ({
      label: text(item.label, 60, 'ভ্যারিয়েন্ট'),
      sku: text(item.sku, 40, 'SKU', { required: false })
    }))));
  }
  return fields;
}
