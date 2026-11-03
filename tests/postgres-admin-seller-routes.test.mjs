import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresAdminSellerRoutes } from '../apps/api/src/postgres-admin-seller-routes.mjs';

function setup({ seller = { user_id: 'seller-1', shop_name: 'Test Shop', status: 'PENDING', account_status: 'ACTIVE' }, changed = 1 } = {}) {
  const routes = [];
  const calls = [];
  const database = {
    q(sql) {
      return {
        async get(...args) {
          calls.push({ method: 'get', sql, args });
          if (sql.includes('FROM seller_profiles sp JOIN users u')) return seller;
          return undefined;
        },
        async all(...args) {
          calls.push({ method: 'all', sql, args });
          return [{ user_id: 'seller-1', status: 'PENDING', has_nid: true, has_trade_license: false }];
        },
        async run(...args) {
          calls.push({ method: 'run', sql, args });
          return { changes: changed, rows: [] };
        }
      };
    },
    async tx(callback) {
      calls.push({ method: 'tx-start' });
      try { return await callback(); }
      finally { calls.push({ method: 'tx-end' }); }
    }
  };
  registerPostgresAdminSellerRoutes(
    (method, path, roles, handler) => routes.push({ method, path, roles, handler }),
    (data, status = 200) => ({ status, body: { data } }),
    { database }
  );
  return { routes, calls };
}
const route = (h, method, path) => h.routes.find(item => item.method === method && item.path === path);

test('admin seller routes are role-scoped and expose a filtered seller queue', async () => {
  const h = setup();
  assert.deepEqual(route(h, 'GET', '/api/v1/admin/sellers').roles, ['ADMIN']);
  assert.deepEqual(route(h, 'PATCH', '/api/v1/admin/sellers/:id/status').roles, ['ADMIN']);
  const result = await route(h, 'GET', '/api/v1/admin/sellers').handler({
    url: new URL('https://haat.test/api/v1/admin/sellers?status=PENDING')
  });
  assert.equal(result.body.data[0].user_id, 'seller-1');
  assert.ok(h.calls.some(call => call.method === 'all' && call.args[0] === 'PENDING'));
});

test('admin approval updates seller status, writes audit log and notifies seller in one transaction', async () => {
  const h = setup();
  const result = await route(h, 'PATCH', '/api/v1/admin/sellers/:id/status').handler({
    user: { id: 'admin-1' }, params: ['seller-1'], body: { status: 'APPROVED', note: 'Documents checked' }
  });
  assert.deepEqual(result.body.data, {
    seller_id: 'seller-1', shop_name: 'Test Shop', previous_status: 'PENDING', status: 'APPROVED'
  });
  assert.ok(h.calls.some(call => call.method === 'run' && call.sql.startsWith('UPDATE seller_profiles')));
  assert.ok(h.calls.some(call => call.method === 'run' && call.sql.includes('INSERT INTO audit_logs')));
  assert.ok(h.calls.some(call => call.method === 'run' && call.sql.includes('INSERT INTO notifications')));
  assert.equal(h.calls[0].method, 'tx-start');
  assert.equal(h.calls.at(-1).method, 'tx-end');
});

test('seller lifecycle rejects invalid status and invalid transitions', async () => {
  const h = setup();
  await assert.rejects(route(h, 'PATCH', '/api/v1/admin/sellers/:id/status').handler({
    user: { id: 'admin-1' }, params: ['seller-1'], body: { status: 'OWNER' }
  }), error => error.status === 400);
  await assert.rejects(route(h, 'PATCH', '/api/v1/admin/sellers/:id/status').handler({
    user: { id: 'admin-1' }, params: ['seller-1'], body: { status: 'SUSPENDED' }
  }), error => error.status === 409);
});

test('inactive accounts and concurrent status changes cannot be approved', async () => {
  const inactive = setup({ seller: { user_id: 'seller-1', shop_name: 'Test Shop', status: 'PENDING', account_status: 'DISABLED' } });
  await assert.rejects(route(inactive, 'PATCH', '/api/v1/admin/sellers/:id/status').handler({
    user: { id: 'admin-1' }, params: ['seller-1'], body: { status: 'APPROVED' }
  }), error => error.status === 409);

  const raced = setup({ changed: 0 });
  await assert.rejects(route(raced, 'PATCH', '/api/v1/admin/sellers/:id/status').handler({
    user: { id: 'admin-1' }, params: ['seller-1'], body: { status: 'APPROVED' }
  }), error => error.status === 409);
  assert.equal(raced.calls.some(call => call.sql?.includes('INSERT INTO audit_logs')), false);
});

test('unknown seller returns 404 and status filters reject unknown values', async () => {
  const missing = setup({ seller: undefined });
  await assert.rejects(route(missing, 'PATCH', '/api/v1/admin/sellers/:id/status').handler({
    user: { id: 'admin-1' }, params: ['missing'], body: { status: 'APPROVED' }
  }), error => error.status === 404);
  const h = setup();
  await assert.rejects(route(h, 'GET', '/api/v1/admin/sellers').handler({
    url: new URL('https://haat.test/api/v1/admin/sellers?status=OWNER')
  }), error => error.status === 400);
});
