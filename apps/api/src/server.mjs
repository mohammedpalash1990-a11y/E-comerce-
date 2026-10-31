import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const port = Number(process.env.PORT || 4000);
const file = resolve(process.env.SQLITE_FILE || 'data/marketplace.sqlite');
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec(`PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, slug TEXT UNIQUE, name_bn TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, category_id TEXT, name_bn TEXT NOT NULL, name_en TEXT NOT NULL, price_paisa INTEGER NOT NULL, stock INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, total_paisa INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);\nCREATE TABLE IF NOT EXISTS order_items(id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id TEXT NOT NULL, product_name_bn TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price_paisa INTEGER NOT NULL);`);
const orderItemColumns = db.prepare('PRAGMA table_info(order_items)').all().map(row => row.name);
if (!orderItemColumns.includes('seller_id')) db.exec('ALTER TABLE order_items ADD COLUMN seller_id TEXT');
if (!orderItemColumns.includes('seller_order_id')) db.exec('ALTER TABLE order_items ADD COLUMN seller_order_id TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS seller_orders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONFIRMED',
  subtotal_paisa INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(order_id, seller_id)
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_seller_orders_seller_created ON seller_orders(seller_id, created_at)");

const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(row => row.name);
for (const [name, definition] of [['delivery_name', "TEXT NOT NULL DEFAULT ''"], ['delivery_phone', "TEXT NOT NULL DEFAULT ''"], ['delivery_address', "TEXT NOT NULL DEFAULT ''"], ['delivery_area', "TEXT NOT NULL DEFAULT ''"], ['customer_note', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!orderColumns.includes(name)) db.exec('ALTER TABLE orders ADD COLUMN ' + name + ' ' + definition);
}

const q = sql => db.prepare(sql);
const hash = password => {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
};
const columns = table => db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name);
if (!columns('products').includes('seller_id')) db.exec('ALTER TABLE products ADD COLUMN seller_id TEXT');
if (!columns('products').includes('status')) db.exec("ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'");

if (!q('SELECT id FROM users LIMIT 1').get()) {
  const customerId = randomUUID();
  const sellerId = randomUUID();
  q('INSERT INTO users VALUES(?,?,?,?,?)').run(customerId, '01700000003', 'Demo Customer', hash('Customer@12345'), 'CUSTOMER');
  q('INSERT INTO users VALUES(?,?,?,?,?)').run(sellerId, '01700000002', 'Demo Seller', hash('Seller@12345'), 'SELLER');
  q('INSERT INTO users VALUES(?,?,?,?,?)').run(randomUUID(), '01700000001', 'Platform Admin', hash('Admin@12345'), 'ADMIN');
  for (const [slug, name] of [['electronics', 'ইলেকট্রনিক্স'], ['fashion', 'ফ্যাশন'], ['home', 'ঘর ও জীবন']]) {
    q('INSERT INTO categories VALUES(?,?,?)').run(randomUUID(), slug, name);
  }
  const cats = q('SELECT id,slug FROM categories').all();
  for (const [name, bn, price, stock, slug] of [
    ['Wireless Earbuds', 'ওয়্যারলেস ইয়ারবাড', 189000, 32, 'electronics'],
    ['Cotton Panjabi', 'কটন পাঞ্জাবি', 129000, 18, 'fashion'],
    ['Desk Lamp', 'ডেস্ক ল্যাম্প', 95000, 12, 'home']
  ]) {
    q('INSERT INTO products(id,category_id,name_bn,name_en,price_paisa,stock,active,seller_id,status) VALUES(?,?,?,?,?,?,1,?,?)')
      .run(randomUUID(), cats.find(category => category.slug === slug).id, bn, name, price, stock, sellerId, 'ACTIVE');
  }
}

const sessions = new Map();
const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};
async function read(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100000) throw new Error('Payload too large');
  }
  return raw ? JSON.parse(raw) : {};
}
function sessionFor(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const userId = sessions.get(token);
  return userId ? q('SELECT id,name,role FROM users WHERE id=?').get(userId) : null;
}
function requireRole(user, role, res) {
  if (!user) { send(res, 401, { error: 'Authentication required' }); return false; }
  if (user.role !== role) { send(res, 403, { error: 'You do not have permission for this action' }); return false; }
  return true;
}
function productView(row) {
  return { ...row, price_bdt: row.price_paisa / 100 };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true, service: 'marketplace-api' });
    }
    if (req.method === 'GET' && path === '/api/v1/categories') {
      return send(res, 200, { data: q('SELECT slug,name_bn FROM categories ORDER BY name_bn').all() });
    }
    if (req.method === 'GET' && path === '/api/v1/products') {
      const term = (url.searchParams.get('q') || '').slice(0, 80);
      const rows = q("SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.stock,c.slug category_slug FROM products p JOIN categories c ON c.id=p.category_id WHERE p.active=1 AND p.status='ACTIVE' AND (p.name_bn LIKE ? OR p.name_en LIKE ?) ORDER BY p.name_bn")
        .all('%' + term + '%', '%' + term + '%');
      return send(res, 200, { data: rows.map(productView) });
    }

    if (req.method === 'POST' && path === '/api/v1/auth/login') {
      const body = await read(req);
      const user = q('SELECT * FROM users WHERE phone=?').get(String(body.phone || '').trim());
      if (!user) return send(res, 401, { error: 'Invalid phone or password' });
      const [salt, key] = user.password.split(':');
      const actual = scryptSync(String(body.password || ''), salt, 64);
      const expected = Buffer.from(key, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return send(res, 401, { error: 'Invalid phone or password' });
      }
      const token = randomUUID();
      sessions.set(token, user.id);
      return send(res, 200, { token, data: { id: user.id, name: user.name, role: user.role } });
    }

    if (req.method === 'GET' && path === '/api/v1/seller/orders') {
      const user = sessionFor(req);
      if (!requireRole(user, 'SELLER', res)) return;
      const orders = q(`SELECT so.id,so.order_id,so.status,so.subtotal_paisa,so.created_at,
        o.delivery_name,o.delivery_phone,o.delivery_address,o.delivery_area,o.customer_note,
        u.name customer_name,u.phone customer_phone
        FROM seller_orders so JOIN orders o ON o.id=so.order_id
        JOIN users u ON u.id=o.user_id WHERE so.seller_id=?
        ORDER BY so.created_at DESC LIMIT 200`).all(user.id);
      return send(res, 200, { data: orders.map(order => ({
        id: order.id, orderNumber: 'BD-' + order.order_id.slice(0, 8).toUpperCase(),
        status: order.status, subtotal_bdt: order.subtotal_paisa / 100, created_at: order.created_at,
        customer: { name: order.customer_name, phone: order.customer_phone },
        delivery: { name: order.delivery_name, phone: order.delivery_phone, address: order.delivery_address, area: order.delivery_area, note: order.customer_note },
        items: q('SELECT product_name_bn,quantity,unit_price_paisa FROM order_items WHERE seller_order_id=?').all(order.id)
          .map(item => ({ name_bn: item.product_name_bn, quantity: item.quantity, unit_price_bdt: item.unit_price_paisa / 100 }))
      })) });
    }

    const sellerOrderStatusMatch = path.match(/^\\/api\\/v1\\/seller\\/orders\\/([0-9a-f-]{36})\\/status$/i);
    if (req.method === 'POST' && sellerOrderStatusMatch) {
      const user = sessionFor(req);
      if (!requireRole(user, 'SELLER', res)) return;
      const next = String((await read(req)).status || '');
      if (!['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(next)) return send(res, 400, { error: 'Invalid seller order status' });
      db.exec('BEGIN IMMEDIATE');
      try {
        const order = q('SELECT id,order_id,status FROM seller_orders WHERE id=? AND seller_id=?').get(sellerOrderStatusMatch[1], user.id);
        if (!order) { db.exec('ROLLBACK'); return send(res, 404, { error: 'Seller order not found' }); }
        const transitions = { CONFIRMED: ['PROCESSING', 'CANCELLED'], PROCESSING: ['SHIPPED', 'CANCELLED'], SHIPPED: ['DELIVERED'] };
        if (!(transitions[order.status] || []).includes(next)) { db.exec('ROLLBACK'); return send(res, 409, { error: 'এই অর্ডারের বর্তমান অবস্থা থেকে এই পরিবর্তন করা যাবে না' }); }
        if (next === 'CANCELLED') {
          for (const item of q('SELECT product_id,quantity FROM order_items WHERE seller_order_id=?').all(order.id)) {
            q('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity, item.product_id);
          }
        }
        q('UPDATE seller_orders SET status=? WHERE id=? AND seller_id=?').run(next, order.id, user.id);
        const statuses = q('SELECT status FROM seller_orders WHERE order_id=?').all(order.order_id).map(row => row.status);
        let parent = 'CONFIRMED';
        if (statuses.length && statuses.every(status => status === 'CANCELLED')) parent = 'CANCELLED';
        else if (statuses.every(status => ['DELIVERED', 'CANCELLED'].includes(status))) parent = statuses.some(status => status === 'DELIVERED') ? 'DELIVERED' : 'CANCELLED';
        else if (statuses.some(status => ['SHIPPED', 'DELIVERED'].includes(status))) parent = 'SHIPPED';
        else if (statuses.some(status => status === 'PROCESSING')) parent = 'PROCESSING';
        q('UPDATE orders SET status=? WHERE id=?').run(parent, order.order_id);
        db.exec('COMMIT');
        return send(res, 200, { data: { id: order.id, status: next, parent_status: parent } });
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }

    if (req.method === 'GET' && path === '/api/v1/seller/products') {
      const user = sessionFor(req);
      if (!requireRole(user, 'SELLER', res)) return;
      const rows = q('SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.stock,p.status,c.slug category_slug FROM products p JOIN categories c ON c.id=p.category_id WHERE p.seller_id=? ORDER BY p.rowid DESC').all(user.id);
      return send(res, 200, { data: rows.map(productView) });
    }

    if (req.method === 'POST' && path === '/api/v1/seller/products') {
      const user = sessionFor(req);
      if (!requireRole(user, 'SELLER', res)) return;
      const body = await read(req);
      const nameBn = String(body.name_bn || '').trim();
      const nameEn = String(body.name_en || '').trim();
      const categorySlug = String(body.category_slug || '').trim();
      const price = Number(body.price_bdt);
      const stock = Number(body.stock);
      const category = q('SELECT id FROM categories WHERE slug=?').get(categorySlug);
      if (!nameBn || !nameEn || nameBn.length > 160 || nameEn.length > 160 ||
          !category || !Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < 0 || stock > 1000000) {
        return send(res, 400, { error: 'Valid names, category, price and stock are required' });
      }
      const pricePaisa = Math.round(price * 100);
      if (!Number.isSafeInteger(pricePaisa) || pricePaisa < 1) return send(res, 400, { error: 'Invalid product price' });
      const id = randomUUID();
      q("INSERT INTO products(id,category_id,name_bn,name_en,price_paisa,stock,active,seller_id,status) VALUES(?,?,?,?,?,?,0,?,'PENDING_REVIEW')")
        .run(id, category.id, nameBn, nameEn, pricePaisa, stock, user.id);
      return send(res, 201, { data: { id, status: 'PENDING_REVIEW', message: 'পণ্যটি অ্যাডমিন অনুমোদনের অপেক্ষায় আছে' } });
    }

    if (req.method === 'GET' && path === '/api/v1/admin/products/pending') {
      const user = sessionFor(req);
      if (!requireRole(user, 'ADMIN', res)) return;
      const rows = q("SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.stock,p.status,c.slug category_slug,u.name seller_name FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN users u ON u.id=p.seller_id WHERE p.status='PENDING_REVIEW' ORDER BY p.rowid").all();
      return send(res, 200, { data: rows.map(productView) });
    }

    const moderation = path.match(/^\/api\/v1\/admin\/products\/([^/]+)\/(approve|reject)$/);
    if (req.method === 'POST' && moderation) {
      const user = sessionFor(req);
      if (!requireRole(user, 'ADMIN', res)) return;
      const product = q("SELECT id FROM products WHERE id=? AND status='PENDING_REVIEW'").get(moderation[1]);
      if (!product) return send(res, 404, { error: 'Pending product not found' });
      const approved = moderation[2] === 'approve';
      q('UPDATE products SET status=?,active=? WHERE id=?').run(approved ? 'ACTIVE' : 'REJECTED', approved ? 1 : 0, product.id);
      return send(res, 200, { data: { id: product.id, status: approved ? 'ACTIVE' : 'REJECTED' } });
    }

    if (req.method === 'GET' && path === '/api/v1/admin/orders') {
      const user = sessionFor(req);
      if (!requireRole(user, 'ADMIN', res)) return;
      const orders = q('SELECT o.id,o.total_paisa,o.status,o.created_at,o.delivery_name,o.delivery_phone,o.delivery_address,o.delivery_area,o.customer_note,u.name customer_name,u.phone customer_phone FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 200').all();
      return send(res, 200, { data: orders.map(order => ({
        id: order.id, orderNumber: 'BD-' + order.id.slice(0, 8).toUpperCase(),
        total_bdt: order.total_paisa / 100, status: order.status, created_at: order.created_at,
        customer: { name: order.customer_name, phone: order.customer_phone },
        delivery: { name: order.delivery_name, phone: order.delivery_phone, address: order.delivery_address, area: order.delivery_area, note: order.customer_note },
        items: q('SELECT product_name_bn,quantity,unit_price_paisa FROM order_items WHERE order_id=?').all(order.id)
          .map(item => ({ name_bn: item.product_name_bn, quantity: item.quantity, unit_price_bdt: item.unit_price_paisa / 100 }))
      })) });
    }

    const orderStatusMatch = path.match(/^\/api\/v1\/admin\/orders\/([0-9a-f-]{36})\/status$/i);
    if (req.method === 'POST' && orderStatusMatch) {
      const orderStatusRoute = orderStatusMatch[1];
      const user = sessionFor(req);
      if (!requireRole(user, 'ADMIN', res)) return;
      const next = String((await read(req)).status || '');
      if (!['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(next)) return send(res, 400, { error: 'Invalid order status' });
      const order = q('SELECT id,status FROM orders WHERE id=?').get(orderStatusRoute);
      if (!order) return send(res, 404, { error: 'Order not found' });
      const transitions = { CONFIRMED: ['PROCESSING', 'CANCELLED'], PROCESSING: ['SHIPPED', 'CANCELLED'], SHIPPED: ['DELIVERED'] };
      if (!(transitions[order.status] || []).includes(next)) return send(res, 409, { error: 'এই অর্ডারের বর্তমান অবস্থা থেকে এই পরিবর্তন করা যাবে না' });
      db.exec('BEGIN IMMEDIATE');
      try {
        if (next === 'CANCELLED') {
          const sellerOrders = q('SELECT id,status FROM seller_orders WHERE order_id=?').all(order.id);
          if (sellerOrders.length) {
            for (const sellerOrder of sellerOrders) {
              if (sellerOrder.status === 'CANCELLED') continue;
              for (const item of q('SELECT product_id,quantity FROM order_items WHERE seller_order_id=?').all(sellerOrder.id)) {
                q('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity, item.product_id);
              }
              q("UPDATE seller_orders SET status='CANCELLED' WHERE id=?").run(sellerOrder.id);
            }
          } else {
            for (const item of q('SELECT product_id,quantity FROM order_items WHERE order_id=?').all(order.id)) q('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity, item.product_id);
          }
        }
        q('UPDATE orders SET status=? WHERE id=?').run(next, order.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return send(res, 200, { data: { id: order.id, status: next } });
    }

    if (req.method === 'GET' && path === '/api/v1/customer/orders') {
      const user = sessionFor(req);
      if (!requireRole(user, 'CUSTOMER', res)) return;
      const orders = q('SELECT id,total_paisa,status,created_at,delivery_name,delivery_phone,delivery_address,delivery_area,customer_note FROM orders WHERE user_id=? ORDER BY created_at DESC').all(user.id);
      const data = orders.map(order => ({
        orderNumber: 'BD-' + order.id.slice(0, 8).toUpperCase(),
        total_bdt: order.total_paisa / 100,
        status: order.status,
        created_at: order.created_at,
        delivery: { name: order.delivery_name, phone: order.delivery_phone, address: order.delivery_address, area: order.delivery_area, note: order.customer_note },
        items: q('SELECT product_name_bn,quantity,unit_price_paisa FROM order_items WHERE order_id=?').all(order.id)
          .map(item => ({ name_bn: item.product_name_bn, quantity: item.quantity, unit_price_bdt: item.unit_price_paisa / 100 }))
      }));
      return send(res, 200, { data });
    }

    if (req.method === 'POST' && path === '/api/v1/checkout') {
      const user = sessionFor(req);
      if (!requireRole(user, 'CUSTOMER', res)) return;
      const body = await read(req);
      const delivery = {
        name: String(body.delivery?.name || '').trim(),
        phone: String(body.delivery?.phone || '').trim(),
        address: String(body.delivery?.address || '').trim(),
        area: String(body.delivery?.area || '').trim(),
        note: String(body.delivery?.note || '').trim()
      };
      if (!delivery.name || delivery.name.length > 100 || !/^01[3-9]\d{8}$/.test(delivery.phone) || !delivery.address || delivery.address.length > 500 || !delivery.area || delivery.area.length > 100 || delivery.note.length > 500) {
        return send(res, 400, { error: 'নাম, সঠিক বাংলাদেশি মোবাইল, পূর্ণ ঠিকানা ও এলাকা দিতে হবে' });
      }
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) {
        return send(res, 400, { error: 'Cart must contain between 1 and 50 items' });
      }
      const quantities = new Map();
      for (const item of body.items) {
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000 || !item.productId) {
          return send(res, 400, { error: 'Invalid cart item' });
        }
        quantities.set(String(item.productId), (quantities.get(String(item.productId)) || 0) + quantity);
      }
      let total = 0;
      const lines = [];
      for (const [productId, quantity] of quantities) {
        const product = q("SELECT * FROM products WHERE id=? AND active=1 AND status='ACTIVE'").get(productId);
        if (!product || product.stock < quantity) return send(res, 400, { error: 'Invalid item or insufficient stock' });
        total += product.price_paisa * quantity;
        if (!product.seller_id) return send(res, 400, { error: 'এই পণ্যটি কোনো বিক্রেতার সঙ্গে যুক্ত নয়' });
        lines.push({ productId, quantity, name_bn: product.name_bn, unit_price_paisa: product.price_paisa, seller_id: product.seller_id });
      }
      if (!Number.isSafeInteger(total)) return send(res, 400, { error: 'Order total is too large' });
      const id = randomUUID();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const line of lines) {
          const changed = q("UPDATE products SET stock=stock-? WHERE id=? AND stock>=? AND active=1 AND status='ACTIVE'").run(line.quantity, line.productId, line.quantity);
          if (changed.changes !== 1) throw new Error('Stock changed; please refresh your cart');
        }
        q('INSERT INTO orders(id,user_id,total_paisa,status,created_at,delivery_name,delivery_phone,delivery_address,delivery_area,customer_note) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, user.id, total, 'CONFIRMED', new Date().toISOString(), delivery.name, delivery.phone, delivery.address, delivery.area, delivery.note);
        const sellerGroups = new Map();
        for (const line of lines) {
          if (!sellerGroups.has(line.seller_id)) sellerGroups.set(line.seller_id, []);
          sellerGroups.get(line.seller_id).push(line);
        }
        const sellerOrderIds = new Map();
        for (const [sellerId, sellerLines] of sellerGroups) {
          const sellerOrderId = randomUUID();
          sellerOrderIds.set(sellerId, sellerOrderId);
          const sellerSubtotal = sellerLines.reduce((sum, line) => sum + line.unit_price_paisa * line.quantity, 0);
          q('INSERT INTO seller_orders(id,order_id,seller_id,status,subtotal_paisa,created_at) VALUES(?,?,?,?,?,?)')
            .run(sellerOrderId, id, sellerId, 'CONFIRMED', sellerSubtotal, new Date().toISOString());
        }
        for (const line of lines) {
          q('INSERT INTO order_items(id,order_id,product_id,product_name_bn,quantity,unit_price_paisa,seller_id,seller_order_id) VALUES(?,?,?,?,?,?,?,?)')
            .run(randomUUID(), id, line.productId, line.name_bn, line.quantity, line.unit_price_paisa, line.seller_id, sellerOrderIds.get(line.seller_id));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return send(res, 201, { data: { orderNumber: 'BD-' + id.slice(0, 8).toUpperCase(), total_bdt: total / 100, status: 'CONFIRMED' } });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    return send(res, 400, { error: error.message || 'Bad request' });
  }
});
server.listen(port, '0.0.0.0', () => console.log('API listening on ' + port));
