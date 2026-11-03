import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresSellerProductRoutes } from '../apps/api/src/postgres-seller-product-routes.mjs';

function setup({ profile = { status: 'PENDING', account_status: 'ACTIVE' }, product = null, category = { id: 'cat-1' }, brand = { id: 'brand-1' } } = {}) {
  const routes = [], calls = [];
  const database = {
    q(sql) {
      return {
        async get(...args) {
          calls.push({ method: 'get', sql, args });
          if (sql.includes('FROM seller_profiles sp JOIN users')) return profile;
          if (sql.includes('FROM categories WHERE slug')) return category;
          if (sql.includes('FROM brands WHERE slug')) return brand;
          if (sql.includes('FROM products WHERE id=? AND seller_id=?')) return product;
          if (sql.includes('SELECT slug FROM categories')) return { slug: 'tea' };
          return undefined;
        },
        async all(...args) {
          calls.push({ method: 'all', sql, args });
          if (sql.includes('FROM products p LEFT JOIN categories')) return [{ id: 'p-1', name_bn: 'চা', name_en: 'Tea', price_paisa: 15000, discount_paisa: null, stock: 12, status: 'ACTIVE', sku: 'TEA-1', category_slug: 'tea', description: '', active: 1, image: null, updated_at: '2026-11-03' }];
          if (sql.includes('FROM product_images')) return [{ url: 'https://cdn.example.test/tea.jpg' }];
          return [];
        },
        async run(...args) {
          calls.push({ method: 'run', sql, args });
          return { changes: 1, rows: [] };
        }
      };
    },
    async tx(fn) { calls.push({ method: 'tx-start' }); try { return await fn(); } finally { calls.push({ method: 'tx-end' }); } }
  };
  registerPostgresSellerProductRoutes(
    (method, path, roles, handler, opts) => routes.push({ method, path, roles, handler, opts }),
    (data, status = 200) => ({ status, body: { data } }),
    { database, id: () => 'generated-id', now: () => '2026-11-03T00:00:00.000Z' }
  );
  return { routes, calls };
}
const find = (h, method, path) => h.routes.find(item => item.method === method && item.path === path);
const user = { id: 'seller-1', role: 'SELLER' };
const productBody = {
  name_bn: 'চা', name_en: 'Tea', price_bdt: 150, stock: 12, category_slug: 'tea',
  description: 'Premium tea', sku: 'TEA-1', brand_slug: 'brand',
  images: ['https://cdn.example.test/tea.jpg'], variants: [{ label: '250g', sku: 'TEA-250' }]
};

test('seller product endpoints are scoped to SELLER and expose only supported CRUD operations', () => {
  const h = setup();
  assert.deepEqual(find(h, 'GET', '/api/v1/seller/products').roles, ['SELLER']);
  assert.deepEqual(find(h, 'GET', '/api/v1/seller/products/:id').roles, ['SELLER']);
  assert.deepEqual(find(h, 'POST', '/api/v1/seller/products').roles, ['SELLER']);
  assert.deepEqual(find(h, 'PUT', '/api/v1/seller/products/:id').roles, ['SELLER']);
  assert.deepEqual(find(h, 'DELETE', '/api/v1/seller/products/:id').roles, ['SELLER']);
  assert.equal(find(h, 'POST', '/api/v1/seller/products').opts.limit, 3000000);
  assert.equal(find(h, 'PATCH', '/api/v1/seller/products/:id/stock'), undefined);
});

test('seller list filters by authenticated seller and caps pagination', async () => {
  const h = setup();
  const result = await find(h, 'GET', '/api/v1/seller/products').handler({
    user, url: new URL('https://haat.test/api/v1/seller/products?status=ACTIVE&limit=999&offset=-4')
  });
  assert.equal(result.body.data[0].id, 'p-1');
  const call = h.calls.find(item => item.method === 'all' && item.sql?.includes('FROM products p LEFT JOIN categories'));
  assert.deepEqual(call.args, ['seller-1', 'ACTIVE', 100, 0]);
});

test('seller cannot read another seller product', async () => {
  const h = setup({ product: null });
  await assert.rejects(find(h, 'GET', '/api/v1/seller/products/:id').handler({ user, params: ['foreign-product'] }),
    error => error.status === 404);
});

test('pending seller can submit a validated product into moderation queue', async () => {
  const h = setup();
  const result = await find(h, 'POST', '/api/v1/seller/products').handler({ user, body: productBody });
  assert.equal(result.status, 201);
  assert.equal(result.body.data.status, 'PENDING_REVIEW');
  assert.ok(h.calls.some(item => item.sql?.includes("VALUES(?,?,?,?,?,?,0,?,'PENDING_REVIEW'")));
  assert.ok(h.calls.some(item => item.sql?.includes('INSERT INTO product_images')));
  assert.ok(h.calls.some(item => item.sql?.includes('INSERT INTO audit_logs')));
});

test('seller submission rejects invalid account state, category, price, image and variant data', async () => {
  const suspended = setup({ profile: { status: 'SUSPENDED', account_status: 'ACTIVE' } });
  await assert.rejects(find(suspended, 'POST', '/api/v1/seller/products').handler({ user, body: productBody }), error => error.status === 403);
  const badCategory = setup({ category: null });
  await assert.rejects(find(badCategory, 'POST', '/api/v1/seller/products').handler({ user, body: productBody }), error => error.status === 400);
  const badPrice = setup();
  await assert.rejects(find(badPrice, 'POST', '/api/v1/seller/products').handler({ user, body: { ...productBody, price_bdt: -1 } }), error => error.status === 400);
  const badImage = setup();
  await assert.rejects(find(badImage, 'POST', '/api/v1/seller/products').handler({ user, body: { ...productBody, images: ['javascript:alert(1)'] } }), error => error.status === 400);
  const badVariant = setup();
  await assert.rejects(find(badVariant, 'POST', '/api/v1/seller/products').handler({ user, body: { ...productBody, variants: [{ label: '' }] } }), error => error.status === 400);
});

test('seller edits only owned product and forces resubmission for moderation', async () => {
  const owned = { id: 'p-1', seller_id: 'seller-1', price_paisa: 15000, discount_paisa: null, status: 'ACTIVE' };
  const h = setup({ profile: { status: 'APPROVED', account_status: 'ACTIVE' }, product: owned });
  const result = await find(h, 'PUT', '/api/v1/seller/products/:id').handler({
    user, params: ['p-1'], body: { name_bn: 'নতুন চা', images: ['https://cdn.example.test/new.jpg'] }
  });
  assert.equal(result.body.data.status, 'PENDING_REVIEW');
  assert.ok(h.calls.some(item => item.sql?.includes("status='PENDING_REVIEW',active=0")));
  assert.ok(h.calls.some(item => item.args?.includes('PRODUCT_EDIT_SUBMITTED')));
});

test('seller cannot submit a discount greater than or equal to effective price', async () => {
  const owned = { id: 'p-1', seller_id: 'seller-1', price_paisa: 15000, discount_paisa: null, status: 'ACTIVE' };
  const h = setup({ profile: { status: 'APPROVED', account_status: 'ACTIVE' }, product: owned });
  await assert.rejects(find(h, 'PUT', '/api/v1/seller/products/:id').handler({
    user, params: ['p-1'], body: { price_bdt: 100, discount_price_bdt: 100 }
  }), error => error.status === 400);
});

test('seller archive is ownership-scoped, removes cart references and writes audit', async () => {
  const owned = { id: 'p-1', seller_id: 'seller-1', price_paisa: 15000, discount_paisa: null, status: 'ACTIVE' };
  const h = setup({ profile: { status: 'APPROVED', account_status: 'ACTIVE' }, product: owned });
  const result = await find(h, 'DELETE', '/api/v1/seller/products/:id').handler({ user, params: ['p-1'] });
  assert.deepEqual(result.body.data, { id: 'p-1', archived: true });
  assert.ok(h.calls.some(item => item.sql?.includes("status='ARCHIVED',active=0")));
  assert.ok(h.calls.some(item => item.sql?.includes('DELETE FROM cart_items')));
  assert.ok(h.calls.some(item => item.args?.includes('PRODUCT_ARCHIVE')));
});
