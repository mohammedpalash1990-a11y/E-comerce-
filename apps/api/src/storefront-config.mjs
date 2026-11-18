import { HttpError, text } from './postgres-shared.mjs';

export const DEFAULT_STOREFRONT_CONFIG = Object.freeze({
  promo_banner_bn: 'বাংলাদেশজুড়ে কিউরেটেড মাল্টি-ভেন্ডর মার্কেটপ্লেস · প্রথম অর্ডারে ১০% ছাড় কোড: HAAT10',
  promo_banner_en: 'Bangladesh Curated Multi-Vendor Marketplace · Use code HAAT10 for 10% off orders ৳1,000+',
  hero_eyebrow: 'BANGLADESH MULTI-VENDOR MARKETPLACE',
  hero_title_bn: 'বাছাইকৃত কারিগরি,\nএক মার্কেটপ্লেসে।',
  hero_title_en: 'Curated Craft,\nOne Marketplace.',
  hero_subtitle_bn: 'যাচাইকৃত বাংলাদেশি বিক্রেতা ও আধুনিক ব্র্যান্ডের সেরা পণ্য—এক কার্টে মাল্টি-ভেন্ডর অর্ডার, স্বচ্ছ ডেলিভারি চার্জ ও রিয়েল-টাইম অর্ডার ট্র্যাকিং।',
  hero_subtitle_en: 'Shop verified Bangladeshi artisans and modern brands in a single cart—transparent shipping, multi-vendor fulfillment, and live tracking.',
  hero_image_url: '/assets/images/haat_hero_marketplace_1794891418879.jpg',
  dhaka_shipping_bdt: 60,
  outside_shipping_bdt: 120,
  free_shipping_over_bdt: 0,
  default_commission_bps: 800
});

const NUMBER_KEYS = new Set([
  'dhaka_shipping_bdt',
  'outside_shipping_bdt',
  'free_shipping_over_bdt',
  'default_commission_bps'
]);

export function mergeStorefrontConfig(rows = []) {
  const out = { ...DEFAULT_STOREFRONT_CONFIG };
  for (const row of rows || []) {
    if (!row || !Object.prototype.hasOwnProperty.call(DEFAULT_STOREFRONT_CONFIG, row.key)) continue;
    if (NUMBER_KEYS.has(row.key)) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) out[row.key] = n;
    } else if (typeof row.value === 'string' && row.value.trim()) {
      out[row.key] = row.value;
    }
  }
  return out;
}

export function validateStorefrontConfig(body = {}, current = DEFAULT_STOREFRONT_CONFIG) {
  const next = {};
  const strFields = [
    ['promo_banner_bn', 240, 'প্রমো ব্যানার (বাংলা)'],
    ['promo_banner_en', 240, 'Promo banner (English)'],
    ['hero_eyebrow', 80, 'Hero eyebrow'],
    ['hero_title_bn', 160, 'হিরো শিরোনাম (বাংলা)'],
    ['hero_title_en', 160, 'Hero title (English)'],
    ['hero_subtitle_bn', 400, 'হিরো বিবরণ (বাংলা)'],
    ['hero_subtitle_en', 400, 'Hero subtitle (English)']
  ];
  for (const [key, max, label] of strFields) {
    if (body[key] !== undefined) next[key] = text(body[key], max, label);
  }
  if (body.hero_image_url !== undefined) {
    const img = String(body.hero_image_url || '').trim();
    if (!(/^https:\/\/[^\s"'<>]+$/i.test(img) || /^\/assets\/[A-Za-z0-9/_.-]+$/.test(img)) || img.length > 500) {
      throw new HttpError(400, 'হিরো ছবি শুধু HTTPS লিংক বা লোকাল /assets/ পাথ হতে পারে');
    }
    next.hero_image_url = img;
  }
  for (const [key, max, label] of [
    ['dhaka_shipping_bdt', 5000, 'ঢাকা ডেলিভারি চার্জ'],
    ['outside_shipping_bdt', 10000, 'ঢাকার বাইরে ডেলিভারি চার্জ'],
    ['free_shipping_over_bdt', 500000, 'ফ্রি ডেলিভারি সীমা']
  ]) {
    if (body[key] !== undefined) {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, label + ' সঠিক নয়');
      next[key] = Math.round(n);
    }
  }
  if (body.default_commission_bps !== undefined) {
    const bps = Number(body.default_commission_bps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 5000) {
      throw new HttpError(400, 'ডিফল্ট কমিশন ০–৫০% (0–5000 bps) হতে হবে');
    }
    next.default_commission_bps = bps;
  }
  if (!Object.keys(next).length) throw new HttpError(400, 'অন্তত একটি সেটিং দিতে হবে');
  return { ...current, ...next, _changed: next };
}

export function computeDynamicShippingPaisa(area, subtotalPaisa, cfg = DEFAULT_STOREFRONT_CONFIG) {
  const freeOverPaisa = Number(cfg.free_shipping_over_bdt || 0) * 100;
  if (freeOverPaisa > 0 && subtotalPaisa >= freeOverPaisa) return 0;
  const isDhaka = /dhaka|ঢাকা/i.test(area || '');
  const feeBdt = isDhaka ? Number(cfg.dhaka_shipping_bdt ?? 60) : Number(cfg.outside_shipping_bdt ?? 120);
  return Math.round(feeBdt * 100);
}

export async function loadPgStorefrontConfig(database) {
  try {
    const rows = await database.q('SELECT key,value FROM platform_settings').all();
    return mergeStorefrontConfig(rows);
  } catch {
    return { ...DEFAULT_STOREFRONT_CONFIG };
  }
}
