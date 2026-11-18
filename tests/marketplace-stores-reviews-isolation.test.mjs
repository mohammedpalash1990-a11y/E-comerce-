import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, delivery } from './helpers.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresCatalogRepository } from '../apps/api/src/postgres-catalog.mjs';
import { registerPostgresCatalogRoutes } from '../apps/api/src/postgres-catalog-routes.mjs';
import { registerPostgresOperationsRoutes } from '../apps/api/src/postgres-operations-routes.mjs';

const api = await startApi(4441);
const { request: R, login } = api;
test.after(() => api.stop());

test('Gate 1: postgres-server static import graph has zero SQLite/core/db imports', () => {
  const root = path.resolve('apps/api/src/postgres-server.mjs');
  const seen = new Set();
  const forbidden = [];
  const stack = [root];
  const importRe = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1] || m[2];
      if (spec === 'node:sqlite' || spec.includes('sqlite')) {
        forbidden.push(`${path.basename(file)} -> ${spec}`);
        continue;
      }
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec);
        const base = path.basename(resolved);
        if (base === 'core.mjs' || base === 'db.mjs') {
          forbidden.push(`${path.basename(file)} -> ${spec}`);
        } else {
          stack.push(resolved);
        }
      }
    }
  }
  assert.ok(seen.size >= 15, `Expected full PG module graph, got ${seen.size}`);
  assert.deepEqual(forbidden, []);
});

test('SQLite live API: public verified stores list/detail excludes PII and pending sellers, preserves getProduct seller_id omission', async () => {
  const storesRes = await R('/api/v1/stores');
  assert.equal(storesRes.status, 200);
  assert.ok(Array.isArray(storesRes.data.data));
  assert.ok(storesRes.data.data.length >= 1, 'Expected at least one seeded approved store');

  const store = storesRes.data.data[0];
  assert.ok(store.id);
  assert.ok(store.shop_name);
  assert.equal(typeof store.product_count, 'number');
  assert.equal(typeof store.review_count, 'number');
  // Strict zero-PII enforcement on public store payload
  for (const secretKey of ['phone', 'email', 'kyc_nid', 'kyc_trade_license', 'password', 'password_hash', 'password_salt']) {
    assert.equal(secretKey in store, false, `Public store payload must not expose ${secretKey}`);
  }

  // Register a pending seller and confirm it does NOT leak into public /stores or /stores/:id
  const pendingReg = await R('/api/v1/auth/register-seller', {
    method: 'POST',
    body: {
      name: 'Pending Merchant',
      phone: '01799887766',
      email: 'pending.seller@example.com',
      password: 'Password@123',
      shop_name: 'Unapproved Secret Shop',
      shop_address: 'House 12, Banani, Dhaka',
      business_info: 'Pending review merchant',
      kyc_nid: '1234567890123'
    }
  });
  assert.equal(pendingReg.status, 201);
  const pendingSellerId = pendingReg.data.data.id;

  const afterRegStores = (await R('/api/v1/stores')).data.data;
  assert.equal(afterRegStores.some(s => s.id === pendingSellerId || s.shop_name === 'Unapproved Secret Shop'), false);
  assert.equal((await R('/api/v1/stores/' + pendingSellerId)).status, 404);
  assert.equal((await R('/api/v1/stores/nonexistent-store')).status, 404);

  // Store detail returns store + its approved products
  const detailRes = await R('/api/v1/stores/' + store.id);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.data.data.id, store.id);
  assert.ok(Array.isArray(detailRes.data.data.products));
  assert.equal(detailRes.data.data.products.length, store.product_count);
  assert.equal('phone' in detailRes.data.data, false);

  // Catalog filter by seller_id works and product detail still omits seller_id
  const bySeller = await R('/api/v1/products?seller_id=' + encodeURIComponent(store.id));
  assert.equal(bySeller.status, 200);
  assert.equal(bySeller.data.data.length, store.product_count);

  if (detailRes.data.data.products.length > 0) {
    const prodDetail = (await R('/api/v1/products/' + detailRes.data.data.products[0].id)).data.data;
    assert.equal('seller_id' in prodDetail, false);
  }
});

test('SQLite live API: admin product detail/edit and review moderation enforce ADMIN RBAC and audit logging', async () => {
  const admin = (await login('01700000001', 'Admin@12345')).data.token;
  const seller = (await login('01700000002', 'Seller@12345')).data.token;
  const customer = (await login('01700000003', 'Customer@12345')).data.token;

  const products = (await R('/api/v1/products?limit=10')).data.data;
  assert.ok(products.length > 0);
  const target = products[0];

  // Admin product detail GET: RBAC + full fields
  assert.equal((await R('/api/v1/admin/products/' + target.id, { token: seller })).status, 403);
  assert.equal((await R('/api/v1/admin/products/' + target.id, { token: customer })).status, 403);
  assert.equal((await R('/api/v1/admin/products/missing-prod', { token: admin })).status, 404);

  const prodGet = await R('/api/v1/admin/products/' + target.id, { token: admin });
  assert.equal(prodGet.status, 200);
  assert.equal(prodGet.data.data.id, target.id);
  assert.ok('category_slug' in prodGet.data.data);
  assert.ok(Array.isArray(prodGet.data.data.images));

  // Admin product edit PUT persists
  const updatedEn = target.name_en + ' (Curated)';
  const prodPut = await R('/api/v1/admin/products/' + target.id, {
    method: 'PUT',
    token: admin,
    body: {
      name_bn: target.name_bn,
      name_en: updatedEn,
      category_slug: prodGet.data.data.category_slug,
      price_bdt: prodGet.data.data.price_bdt,
      stock: prodGet.data.data.stock
    }
  });
  assert.equal(prodPut.status, 200);
  const afterPut = (await R('/api/v1/admin/products/' + target.id, { token: admin })).data.data;
  assert.equal(afterPut.name_en, updatedEn);

  // Create delivered order so customer can submit a review, then moderate it as ADMIN
  const ord = await R('/api/v1/checkout', {
    method: 'POST',
    token: customer,
    body: { delivery: delivery(), payment_method: 'COD', items: [{ productId: target.id, quantity: 1 }] }
  });
  assert.equal(ord.status, 201);
  for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED']) {
    const s = await R('/api/v1/admin/orders/' + ord.data.data.id + '/status', { method: 'POST', token: admin, body: { status } });
    assert.equal(s.status, 200);
  }

  const revCreate = await R('/api/v1/customer/products/' + target.id + '/reviews', {
    method: 'POST',
    token: customer,
    body: { rating: 4, comment: 'Moderation test review alpha-99' }
  });
  assert.equal(revCreate.status, 201);

  // RBAC on admin reviews list/delete
  assert.equal((await R('/api/v1/admin/reviews', { token: seller })).status, 403);
  assert.equal((await R('/api/v1/admin/reviews', { token: customer })).status, 403);

  const listRevs = await R('/api/v1/admin/reviews?q=alpha-99', { token: admin });
  assert.equal(listRevs.status, 200);
  const found = listRevs.data.data.find(r => r.comment === 'Moderation test review alpha-99');
  assert.ok(found, 'Expected admin review list to find newly submitted review');

  assert.equal((await R('/api/v1/admin/reviews/' + found.id, { method: 'DELETE', token: seller })).status, 403);
  const delRes = await R('/api/v1/admin/reviews/' + found.id, { method: 'DELETE', token: admin });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.data.data.deleted, true);

  // Deleting again returns 404 and audit log records REVIEW_DELETE
  assert.equal((await R('/api/v1/admin/reviews/' + found.id, { method: 'DELETE', token: admin })).status, 404);
  const logs = (await R('/api/v1/admin/audit-logs?limit=20', { token: admin })).data.data;
  assert.ok(logs.some(l => l.action === 'REVIEW_DELETE' && l.entity_id === found.id));
});

test('PostgreSQL parity: catalog stores list/detail & seller_id filter + operations admin product detail & review moderation', async () => {
  const calls = [];
  const pool = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes('FROM seller_profiles sp JOIN users u') && text.includes('sp.user_id=$1')) {
        if (values[0] === 'missing') return { rows: [], rowCount: 0 };
        return { rows: [{ id: 'seller-1', shop_name: 'Dhaka Loom', shop_address: 'Banani', business_info: 'Textiles', product_count: '2', average_rating: '4.8', review_count: '5' }], rowCount: 1 };
      }
      if (text.includes('FROM seller_profiles sp JOIN users u')) {
        return { rows: [{ id: 'seller-1', shop_name: 'Dhaka Loom', shop_address: 'Banani', business_info: 'Textiles', product_count: '2', average_rating: '4.8', review_count: '5' }], rowCount: 1 };
      }
      if (text.includes('FROM products p JOIN categories c')) {
        return { rows: [{ id: 'p-1', name_bn: 'জামদানি', name_en: 'Jamdani', price_paisa: '450000', discount_paisa: null, stock: '3', category_slug: 'fashion', brand: 'Loom', seller_shop: 'Dhaka Loom', image: '/j.jpg' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() { throw new Error('No tx needed for catalog reads'); }
  };
  const catalog = createPostgresCatalogRepository(createPostgresDatabase(pool));

  const stores = await catalog.listStores();
  assert.equal(stores.length, 1);
  assert.equal(stores[0].shop_name, 'Dhaka Loom');
  assert.equal(stores[0].product_count, 2);
  assert.equal(stores[0].average_rating, 4.8);
  assert.equal('phone' in stores[0], false);
  assert.match(calls[0].text, /sp\.status='APPROVED'/);
  assert.match(calls[0].text, /u\.status='ACTIVE'/);

  const detail = await catalog.getStore('seller-1');
  assert.equal(detail.id, 'seller-1');
  assert.equal(detail.products.length, 1);
  assert.equal(await catalog.getStore('missing'), null);

  // Routes mount GET /api/v1/stores and GET /api/v1/stores/:id
  const catRoutes = [];
  registerPostgresCatalogRoutes(
    (method, p, roles, handler) => catRoutes.push({ method, path: p, roles, handler }),
    (data, status = 200) => ({ status, body: { data } }),
    { catalogRepository: catalog }
  );
  const listStoresRoute = catRoutes.find(r => r.method === 'GET' && r.path === '/api/v1/stores');
  const getStoreRoute = catRoutes.find(r => r.method === 'GET' && r.path === '/api/v1/stores/:id');
  assert.ok(listStoresRoute);
  assert.ok(getStoreRoute);
  assert.equal((await listStoresRoute.handler()).body.data[0].id, 'seller-1');
  await assert.rejects(getStoreRoute.handler({ params: ['missing'] }), err => err.status === 404);

  // Operations routes: GET /api/v1/admin/products/:id, GET /api/v1/admin/reviews, DELETE /api/v1/admin/reviews/:id
  const opRoutes = [];
  const opCalls = [];
  const mockDb = {
    q(sql) {
      return {
        async get(...args) {
          opCalls.push({ m: 'get', sql, args });
          if (sql.includes('FROM products p') && sql.includes('p.id=?')) {
            if (args[0] === 'missing') return undefined;
            return { id: 'p-1', name_bn: 'পণ্য', name_en: 'Prod', price_paisa: 100000, discount_paisa: null, stock: 5, status: 'ACTIVE', category_slug: 'fashion', brand_slug: '', variants: '[]', sku: 'S1', description: 'Desc' };
          }
          if (sql.includes('FROM reviews WHERE id=?')) {
            return args[0] === 'rev-1' ? { id: 'rev-1', product_id: 'p-1', user_id: 'u-1', rating: 5 } : undefined;
          }
          return undefined;
        },
        async all(...args) {
          opCalls.push({ m: 'all', sql, args });
          if (sql.includes('SELECT url FROM product_images')) return [{ url: '/a.jpg' }];
          if (sql.includes('FROM reviews r JOIN products p')) return [{ id: 'rev-1', product_id: 'p-1', rating: 5, comment: 'Great', product_name_bn: 'পণ্য', customer_name: 'Buyer' }];
          return [];
        },
        async run(...args) {
          opCalls.push({ m: 'run', sql, args });
          return { changes: 1, rows: [] };
        }
      };
    },
    async tx(fn) { return fn(); }
  };
  registerPostgresOperationsRoutes(
    (method, p, roles, handler) => opRoutes.push({ method, path: p, roles, handler }),
    (data, status = 200) => ({ status, body: { data } }),
    { database: mockDb, orderLifecycle: { applySellerStatus: async () => 'DELIVERED' } }
  );

  const getProdRoute = opRoutes.find(r => r.method === 'GET' && r.path === '/api/v1/admin/products/:id');
  const listRevRoute = opRoutes.find(r => r.method === 'GET' && r.path === '/api/v1/admin/reviews');
  const delRevRoute = opRoutes.find(r => r.method === 'DELETE' && r.path === '/api/v1/admin/reviews/:id');
  assert.deepEqual(getProdRoute.roles, ['ADMIN']);
  assert.deepEqual(listRevRoute.roles, ['ADMIN']);
  assert.deepEqual(delRevRoute.roles, ['ADMIN']);

  const gp = await getProdRoute.handler({ params: ['p-1'] });
  assert.equal(gp.body.data.price_bdt, 1000);
  assert.deepEqual(gp.body.data.images, ['/a.jpg']);

  const lr = await listRevRoute.handler({ url: new URL('https://haat.test/api/v1/admin/reviews?q=Great') });
  assert.equal(lr.body.data[0].id, 'rev-1');

  const dr = await delRevRoute.handler({ user: { id: 'admin-1' }, params: ['rev-1'] });
  assert.equal(dr.body.data.deleted, true);
  assert.ok(opCalls.some(c => c.sql.includes('DELETE FROM reviews WHERE id=?')));
  assert.ok(opCalls.some(c => c.sql.includes('INSERT INTO audit_logs') && c.args.includes('REVIEW_DELETE')));
});
