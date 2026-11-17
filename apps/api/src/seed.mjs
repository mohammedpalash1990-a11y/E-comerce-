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
    const brands = {};
    for (const [slug, brandName] of [['haat-studio', 'HAAT Studio'], ['dhaka-loom', 'Dhaka Loom'], ['bengal-leather', 'Bengal Leather']]) {
      const bid = id();
      q('INSERT INTO brands(id,slug,name) VALUES(?,?,?) ON CONFLICT(slug) DO NOTHING').run(bid, slug, brandName);
      brands[slug] = q('SELECT id FROM brands WHERE slug=?').get(slug).id;
    }
    const seededProducts = [
      {
        name: 'Wireless Earbuds', bn: 'ওয়্যারলেস ইয়ারবাড', price: 189000, discount: null, stock: 32, slug: 'electronics',
        brand: 'haat-studio', sku: 'HT-EAR-01',
        desc: 'অ্যাক্টিভ নয়েজ রিডাকশন, ৩২ ঘণ্টা ব্যাটারি লাইফ এবং ম্যাট অবসিডিয়ান চার্জিং কেসসহ প্রিমিয়াম ওয়্যারলেস অডিও।',
        variants: [{ label: 'Obsidian Black', sku: 'HT-EAR-01-BLK' }, { label: 'Champagne Trim', sku: 'HT-EAR-01-GLD' }],
        image: '/assets/images/product_wireless_earbuds_1794891418786.jpg'
      },
      {
        name: 'Cotton Panjabi', bn: 'কটন পাঞ্জাবি', price: 129000, discount: null, stock: 18, slug: 'fashion',
        brand: 'dhaka-loom', sku: 'DL-PNJ-02',
        desc: '১০০% অর্গানিক হ্যান্ডলুম কটন কাপড়ে তৈরি টেইলর্ড আইভরি পাঞ্জাবি—সূক্ষ্ম কলার এমব্রয়ডারি ও আরামদায়ক ফিট।',
        variants: [{ label: 'Size M', sku: 'DL-PNJ-02-M' }, { label: 'Size L', sku: 'DL-PNJ-02-L' }, { label: 'Size XL', sku: 'DL-PNJ-02-XL' }],
        image: '/assets/images/product_cotton_panjabi_1794891418923.jpg'
      },
      {
        name: 'Desk Lamp', bn: 'ডেস্ক ল্যাম্প', price: 95000, discount: null, stock: 12, slug: 'home',
        brand: 'haat-studio', sku: 'HT-LMP-03',
        desc: 'ম্যাট চারকোল অ্যালুমিনিয়াম ও ব্রাশড ব্রাস ফিনিশের মিনিমাল আর্কিটেকচারাল ডেস্ক ল্যাম্প—ওয়ার্ম আই-কেয়ার এলইডি।',
        variants: [{ label: 'Brushed Brass', sku: 'HT-LMP-03-BRS' }],
        image: '/assets/images/product_desk_lamp_1794891419833.jpg'
      },
      {
        name: 'Smart Watch', bn: 'স্মার্ট ওয়াচ', price: 245000, discount: 219000, stock: 9, slug: 'electronics',
        brand: 'haat-studio', sku: 'HT-WTC-04',
        desc: 'ব্রাশড টাইটেনিয়াম বেজেল ও কনিয়াক লেদার স্ট্র্যাপসহ আধুনিক স্মার্টওয়াচ—হার্ট রেট, স্লিপ ও নোটিফিকেশন ট্র্যাকিং।',
        variants: [{ label: 'Cognac Leather', sku: 'HT-WTC-04-CGN' }, { label: 'Obsidian Strap', sku: 'HT-WTC-04-OBS' }],
        image: '/assets/images/product_smart_watch_1794891419650.jpg'
      },
      {
        name: 'Leather Wallet', bn: 'লেদার ওয়ালেট', price: 78000, discount: 69000, stock: 4, slug: 'fashion',
        brand: 'bengal-leather', sku: 'BL-WLT-05',
        desc: 'ফুল-গ্রেইন এস্প্রেসো লেদারে হাতে সেলাই করা স্লিম বাইফোল্ড ওয়ালেট—৮টি কার্ড স্লট ও আরএফআইডি প্রোটেকশন।',
        variants: [{ label: 'Espresso Brown', sku: 'BL-WLT-05-ESP' }],
        image: '/assets/images/product_leather_wallet_1794891419736.jpg'
      }
    ];
    for (const p of seededProducts) {
      const pid = id(), ts = now();
      q("INSERT INTO products(id,category_id,name_bn,name_en,price_paisa,stock,active,seller_id,status,brand_id,description,discount_paisa,sku,variants,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,'ACTIVE',?,?,?,?,?,?,?)")
        .run(pid, cats[p.slug], p.bn, p.name, p.price, p.stock, sellerId, brands[p.brand], p.desc, p.discount, p.sku, JSON.stringify(p.variants), ts, ts);
      if (p.image) q('INSERT INTO product_images(id,product_id,url,position) VALUES(?,?,?,0)').run(id(), pid, p.image);
    }
    q('INSERT INTO coupons(code,type,value,min_order_paisa,max_uses,used_count,expires_at,active) VALUES(?,?,?,?,?,0,NULL,1) ON CONFLICT(code) DO NOTHING').run('HAAT10', 'PERCENT', 10, 100000, 500);
  }
}
