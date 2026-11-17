import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';
import { hashPassword, now } from '../apps/api/src/postgres-shared.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(here, '../apps/api/migrations/postgres');

export async function seedPostgresDatabase(env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('Demo PostgreSQL seed cannot run when NODE_ENV=production');
  }
  const pool = await createPostgresPool({ env });
  try {
    await runPostgresMigrations(pool, migrationDirectory);
    const db = createPostgresDatabase(pool);
    const q = sql => db.q(sql);
    const existing = await q('SELECT COUNT(*)::int AS n FROM users').get();
    if (Number(existing?.n || 0) > 0) {
      return { seeded: false, reason: 'Users table already populated' };
    }
    const ts = now();
    await db.tx(async () => {
      await q('INSERT INTO users(id,phone,email,name,password,role,status,phone_verified,email_verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run('u-admin', '01700000001', 'admin@marketplace.local', 'প্ল্যাটফর্ম অ্যাডমিন', hashPassword('Admin@12345'), 'ADMIN', 'ACTIVE', 1, 1, ts);
      await q('INSERT INTO users(id,phone,email,name,password,role,status,phone_verified,email_verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run('u-seller', '01700000002', 'seller@marketplace.local', 'তানভীর', hashPassword('Seller@12345'), 'SELLER', 'ACTIVE', 1, 1, ts);
      await q('INSERT INTO users(id,phone,email,name,password,role,status,phone_verified,email_verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run('u-customer', '01700000003', 'customer@marketplace.local', 'আরিফ আহমেদ', hashPassword('Customer@123'), 'CUSTOMER', 'ACTIVE', 1, 0, ts);

      await q('INSERT INTO seller_profiles(user_id,shop_name,shop_address,business_info,kyc_nid,kyc_trade_license,status,commission_bps,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run('u-seller', 'Demo Store', 'ঢাকা, মিরপুর ১০', 'ইলেকট্রনিক্স, লাইফস্টাইল ও কিউরেটেড পণ্য', '1234567890', 'TL-2026-001', 'APPROVED', 800, ts);
      await q('INSERT INTO addresses(id,user_id,label,name,phone,address,area,is_default) VALUES(?,?,?,?,?,?,?,?)')
        .run('addr-1', 'u-customer', 'Home', 'আরিফ আহমেদ', '01700000003', 'বাসা ১২, রোড ৫, ধানমন্ডি', 'Dhaka', 1);

      const categories = [
        ['c-elec', 'electronics', 'ইলেকট্রনিক্স', 'Electronics'],
        ['c-fash', 'fashion', 'ফ্যাশন', 'Fashion'],
        ['c-home', 'home', 'ঘর ও জীবন', 'Home & Living'],
        ['c-beau', 'beauty', 'সৌন্দর্য', 'Beauty & Care'],
        ['c-groc', 'grocery', 'মুদি ও চা', 'Grocery & Gourmet'],
        ['c-book', 'books', 'বই ও স্টেশনারি', 'Books & Stationery']
      ];
      for (const [cid, slug, bn, en] of categories) {
        await q('INSERT INTO categories(id,slug,name_bn,name_en) VALUES(?,?,?,?) ON CONFLICT(slug) DO NOTHING').run(cid, slug, bn, en);
      }
      const brands = [
        ['b-haat', 'haat-atelier', 'HAAT Atelier'],
        ['b-deshi', 'deshi-loom', 'Deshi Loom'],
        ['b-bengal', 'bengal-roast', 'Bengal Roast']
      ];
      for (const [bid, slug, name] of brands) {
        await q('INSERT INTO brands(id,slug,name) VALUES(?,?,?) ON CONFLICT(slug) DO NOTHING').run(bid, slug, name);
      }

      const products = [
        ['p-1', 'c-elec', 'ওয়্যারলেস ইয়ারবাডস', 'Wireless Earbuds', 189000, 169000, 25, 'u-seller', 'b-haat', 'অ্যাক্টিভ নয়েজ ক্যানসেলিং ও ২৮ ঘণ্টার ব্যাটারি ব্যাকআপসহ প্রিমিয়াম ট্রু ওয়্যারলেস ইয়ারবাডস।', 'HT-EL-001', JSON.stringify([{ label: 'Obsidian Black', sku: 'HT-EL-001-BLK' }, { label: 'Champagne', sku: 'HT-EL-001-GLD' }]), '/assets/images/haat_earbuds_product_1794891439340.jpg'],
        ['p-2', 'c-fash', 'জামদানি মোটিফ কটন পাঞ্জাবি', 'Jamdani Motif Cotton Panjabi', 285000, 249000, 18, 'u-seller', 'b-deshi', 'টাঙ্গাইলের সূক্ষ্ম তাঁতে বোনা শতভাগ খাঁটি সুতি ও হস্তশিল্পের জামদানি নকশার পাঞ্জাবি।', 'HT-FA-002', JSON.stringify([{ label: 'Size M', sku: 'HT-FA-002-M' }, { label: 'Size L', sku: 'HT-FA-002-L' }, { label: 'Size XL', sku: 'HT-FA-002-XL' }]), '/assets/images/haat_jamdani_panjabi_1794891463506.jpg'],
        ['p-3', 'c-home', 'হস্তনির্মিত ব্রাস ও সিরামিক টি সেট', 'Artisan Brass & Ceramic Tea Set', 320000, null, 12, 'u-seller', 'b-haat', 'হাতে গড়া ম্যাট সিরামিক টিপট এবং পিতলের ট্রে — অতিথি আপ্যায়নের আভিজাত্য।', 'HT-HM-003', JSON.stringify([{ label: '4-Piece Set', sku: 'HT-HM-003-4P' }]), '/assets/images/haat_ceramic_teaset_1794891490821.jpg'],
        ['p-4', 'c-fash', 'ফুল-গ্রেইন লেদার অফিস ব্যাগ', 'Full-Grain Leather Messenger Bag', 460000, 399000, 9, 'u-seller', 'b-haat', 'হাতে সেলাই করা টেকসই চামড়ার ল্যাপটপ ও অফিস মেসেঞ্জার ব্যাগ (১৫ ইঞ্চি পর্যন্ত)।', 'HT-FA-004', JSON.stringify([{ label: 'Chestnut Brown', sku: 'HT-FA-004-BRN' }]), '/assets/images/haat_leather_satchel_1794891513358.jpg'],
        ['p-5', 'c-groc', 'সিলেট সিঙ্গেল-অরিজিন অর্গানিক চা ও মধু', 'Sylhet Single-Origin Tea & Honey Gift', 95000, 82000, 40, 'u-seller', 'b-bengal', 'শ্রীমঙ্গলের বাগান থেকে সংগৃহীত প্রিমিয়াম ব্ল্যাক টি ও সুন্দরবনের খাঁটি মধুর কম্বো প্যাক।', 'HT-GR-005', JSON.stringify([{ label: 'Gift Tin 500g', sku: 'HT-GR-005-500' }]), '/assets/images/haat_sylhet_tea_1794891532820.jpg']
      ];
      for (const [pid, catId, bn, en, price, disc, stock, sellerId, brandId, desc, sku, variants, img] of products) {
        await q(`INSERT INTO products(id,category_id,name_bn,name_en,price_paisa,stock,active,seller_id,status,brand_id,description,discount_paisa,sku,variants,created_at,updated_at)
          VALUES(?,?,?,?,?,?,1,?,'ACTIVE',?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
          .run(pid, catId, bn, en, price, stock, sellerId, brandId, desc, disc, sku, variants, ts, ts);
        await q('INSERT INTO product_images(id,product_id,url,position) VALUES(?,?,?,0) ON CONFLICT(id) DO NOTHING')
          .run('img-' + pid, pid, img);
      }

      await q('INSERT INTO coupons(code,type,value,min_order_paisa,max_uses,max_uses_per_customer,used_count,expires_at,active) VALUES(?,?,?,?,?,?,0,NULL,1) ON CONFLICT(code) DO NOTHING')
        .run('HAAT10', 'PERCENT', 10, 100000, 500, 5);
    });
    return { seeded: true };
  } finally {
    await closePostgresPool(pool);
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  seedPostgresDatabase()
    .then(result => console.log('[postgres seed]', JSON.stringify(result)))
    .catch(err => {
      console.error('[postgres seed] failed:', err.message);
      process.exitCode = 1;
    });
}
