import { q, id, now, hashPassword, config, validPhone, normPhone, checkPassword } from './core.mjs';

// Keep SQLite development data aligned with the canonical PostgreSQL category seed.
// Insert missing slugs individually so partially populated databases are repaired too.
const categories = [
  ['electronics', 'ইলেকট্রনিক্স', 'Electronics'],
  ['fashion', 'ফ্যাশন', 'Fashion'],
  ['home', 'ঘর ও জীবন', 'Home & Living'],
  ['beauty', 'সৌন্দর্য ও ব্যক্তিগত যত্ন', 'Beauty & Personal Care'],
  ['grocery', 'মুদি ও খাদ্য', 'Grocery'],
  ['kids', 'শিশু ও বাচ্চা', 'Kids & Baby'],
  ['sports', 'খেলাধুলা ও আউটডোর', 'Sports & Outdoors'],
  ['books', 'বই ও স্টেশনারি', 'Books & Stationery']
];
for (const [slug, bn, en] of categories) {
  q('INSERT INTO categories(id,slug,name_bn,name_en) VALUES(?,?,?,?) ON CONFLICT(slug) DO NOTHING').run(id(), slug, bn, en);
}

if (!q('SELECT id FROM users LIMIT 1').get()) {
  if (config.prod) {
    // Production: no demo accounts. The first admin comes from environment variables.
    const phone = normPhone(process.env.ADMIN_PHONE), pw = process.env.ADMIN_PASSWORD;
    if (!validPhone(phone) || !pw) throw new Error('Set ADMIN_PHONE and ADMIN_PASSWORD to create the first admin in production');
    checkPassword(pw);
    q("INSERT INTO users(id,phone,email,name,password,role,status,created_at) VALUES(?,?,?,?,?,'ADMIN','ACTIVE',?)").run(id(), phone, process.env.ADMIN_EMAIL || null, 'Platform Admin', hashPassword(pw), now());
  } else {
    const mk = (phone, name, pw, role, email) => { const uid = id(); q('INSERT INTO users(id,phone,email,name,password,role,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(uid, phone, email, name, hashPassword(pw), role, 'ACTIVE', now()); return uid; };
    mk('01700000001', 'Platform Admin', 'Admin@12345', 'ADMIN', 'admin@haat.test');
    const sellerId = mk('01700000002', 'Demo Seller', 'Seller@12345', 'SELLER', 'seller@haat.test');
    mk('01700000003', 'Demo Customer', 'Customer@12345', 'CUSTOMER', 'customer@haat.test');
    q("INSERT INTO seller_profiles VALUES(?,?,?,?,?,?,'APPROVED',800,?)").run(sellerId, 'Demo Store', 'Dhaka', 'Demo seller for development', '1234567890', '', now());
    const cats = Object.fromEntries(q('SELECT id,slug FROM categories').all().map(c => [c.slug, c.id]));
    for (const [name, bn, price, stock, slug] of [['Wireless Earbuds', 'ওয়্যারলেস ইয়ারবাড', 189000, 32, 'electronics'], ['Cotton Panjabi', 'কটন পাঞ্জাবি', 129000, 18, 'fashion'], ['Desk Lamp', 'ডেস্ক ল্যাম্প', 95000, 12, 'home']])
      q("INSERT INTO products(id,category_id,name_bn,name_en,price_paisa,stock,active,seller_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,'ACTIVE',?,?)").run(id(), cats[slug], bn, name, price, stock, sellerId, now(), now());
  }
}
