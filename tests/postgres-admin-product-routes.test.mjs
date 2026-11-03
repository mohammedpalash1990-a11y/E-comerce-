import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresAdminProductRoutes } from '../apps/api/src/postgres-admin-product-routes.mjs';

function setup({ product = { id: 'p-1', seller_id: 'seller-1', status: 'PENDING_REVIEW' }, seller = { status: 'APPROVED', account_status: 'ACTIVE' } } = {}) {
  const routes = [], calls = [];
  const database = {
    q(sql) {
      return {
        async get(...args) {
          calls.push({ sql, args });
          if (sql.includes('FROM products WHERE id=? FOR UPDATE')) return product;
          if (sql.includes('FROM seller_profiles sp JOIN users')) return seller;
          return undefined;
        },
        async all(...args) { calls.push({ sql, args }); return [{ id: 'p-1', name_bn: 'Tea', price_paisa: 12000, discount_paisa: null, stock: 8, status: 'PENDING_REVIEW', seller_id: 'seller-1' }]; },
        async run(...args) { calls.push({ sql, args }); return { changes: 1, rows: [] }; }
      };
    },
    async tx(fn) { calls.push({ sql: '' }); return fn(); }
  };
  registerPostgresAdminProductRoutes((method, path, roles, handler) => routes.push({ method, path, roles, handler }),
    (data, status = 200) => ({ status, body: { data } }), { database, id: () => 'audit-id', now: () => '2026-11-03T00:00:00.000Z' });
  return { routes, calls };
}
const find = (h, method, path) => h.routes.find(x => x.method === method && x.path === path);
const admin = { id: 'admin-1', role: 'ADMIN' };

test('admin moderation endpoints require ADMIN role', () => {
  const h = setup();
  for (const [method, path] of [['GET','/api/v1/admin/products'],['GET','/api/v1/admin/products/pending'],['POST','/api/v1/admin/products/:id/approve'],['POST','/api/v1/admin/products/:id/reject'],['POST','/api/v1/admin/products/:id/suspend'],['POST','/api/v1/admin/products/:id/unsuspend']]) {
    assert.deepEqual(find(h, method, path).roles, ['ADMIN']);
  }
});

test('admin product list validates status and applies bounded pagination', async () => {
  const h = setup();
  const result = await find(h, 'GET', '/api/v1/admin/products').handler({ url: new URL('https://haat.test/api/v1/admin/products?status=PENDING_REVIEW&q=tea&limit=999&offset=5') });
  assert.equal(result.body.data[0].price_bdt, 120);
  assert.deepEqual(h.calls.find(x => x.args?.includes(300))?.args, ['PENDING_REVIEW','%tea%','%tea%','%tea%',300,5]);
});

test('approval verifies seller approval then writes audit and notification in transaction', async () => {
  const h = setup();
  const result = await find(h, 'POST', '/api/v1/admin/products/:id/approve').handler({ user: admin, params: ['p-1'], body: { reason: 'Checked' } });
  assert.deepEqual(result.body.data, { id: 'p-1', status: 'ACTIVE' });
  assert.ok(h.calls.some(x => x.sql?.includes('INSERT INTO audit_logs')));
  assert.ok(h.calls.some(x => x.sql?.includes('INSERT INTO notifications')));
});

test('approval fails when seller is not approved; invalid state transitions fail', async () => {
  const h = setup({ seller: { status: 'PENDING', account_status: 'ACTIVE' } });
  await assert.rejects(find(h, 'POST', '/api/v1/admin/products/:id/approve').handler({ user: admin, params: ['p-1'], body: {} }), e => e.status === 409);
  const active = setup({ product: { id: 'p-1', seller_id: 'seller-1', status: 'ACTIVE' } });
  await assert.rejects(find(active, 'POST', '/api/v1/admin/products/:id/approve').handler({ user: admin, params: ['p-1'], body: {} }), e => e.status === 409);
});
