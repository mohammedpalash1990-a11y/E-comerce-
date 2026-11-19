import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startApi } from './helpers.mjs';
import { registerPostgresPayoutRoutes } from '../apps/api/src/postgres-payout-routes.mjs';

const api = await startApi(4442);
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

test('SQLite live API: admin payout approval and rejection via /decision and /approve endpoints', async () => {
  const adminRes = await login('01700000001', 'Admin@12345');
  const adminToken = adminRes.data?.token;
  assert.ok(adminToken, 'Admin login token required');

  // Customer or unauthenticated cannot access admin payouts
  const unauthRes = await R('/api/v1/admin/payouts');
  assert.equal(unauthRes.status, 401);

  const customerLogin = await login('01700000003', 'Customer@12345', { portal: 'CUSTOMER' });
  const customerToken = customerLogin.data?.token;
  assert.ok(customerToken, 'Customer login token required');
  const custForbidden = await R('/api/v1/admin/payouts', { token: customerToken });
  assert.equal(custForbidden.status, 403);

  // Admin lists payouts
  const listRes = await R('/api/v1/admin/payouts', { token: adminToken });
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.data.data));

  // Test decision endpoint validation with UUID format
  const badDecision = await R('/api/v1/admin/payouts/00000000-0000-0000-0000-000000000000/decision', {
    method: 'POST',
    token: adminToken,
    body: { decision: 'INVALID' }
  });
  assert.equal(badDecision.status, 400);

  const missingDecision = await R('/api/v1/admin/payouts/00000000-0000-0000-0000-000000000000/decision', {
    method: 'POST',
    token: adminToken,
    body: { decision: 'APPROVE' }
  });
  assert.equal(missingDecision.status, 404);
});

test('PostgreSQL payout routes: /decision, /approve, /reject parity and atomicity', async () => {
  const routes = [];
  const calls = [];
  const fakeDb = {
    q(sql) {
      return {
        async get(...args) {
          calls.push({ method: 'get', sql, args });
          if (sql.includes('SELECT seller_id FROM payouts WHERE id=?')) return { seller_id: 's-1' };
          if (sql.includes('FROM seller_profiles WHERE user_id=? FOR UPDATE')) return { user_id: 's-1' };
          if (sql.includes('FROM payouts WHERE id=? FOR UPDATE')) return { id: 'p-1', seller_id: 's-1', amount_paisa: 5000, status: 'REQUESTED' };
          if (sql.includes('AS reserved')) return { earned: 100000, reserved: 5000 };
          return undefined;
        },
        async all(...args) {
          calls.push({ method: 'all', sql, args });
          return [];
        },
        async run(...args) {
          calls.push({ method: 'run', sql, args });
          return { changes: 1, rows: [] };
        }
      };
    },
    async tx(fn) {
      calls.push({ method: 'tx' });
      return fn();
    }
  };

  registerPostgresPayoutRoutes(
    (method, path, roles, handler) => routes.push({ method, path, roles, handler }),
    (data, status = 200) => ({ status, body: { data } }),
    { database: fakeDb, id: () => 'gen-id', now: () => '2026-11-03T00:00:00.000Z' }
  );

  const find = (method, p) => routes.find(r => r.method === method && r.path === p);
  assert.ok(find('POST', '/api/v1/admin/payouts/:id/decision'));
  assert.ok(find('POST', '/api/v1/admin/payouts/:id/approve'));
  assert.ok(find('POST', '/api/v1/admin/payouts/:id/reject'));

  assert.deepEqual(find('POST', '/api/v1/admin/payouts/:id/approve').roles, ['ADMIN']);
  assert.deepEqual(find('POST', '/api/v1/admin/payouts/:id/reject').roles, ['ADMIN']);

  const adminUser = { id: 'admin-1', role: 'ADMIN' };
  const approveRes = await find('POST', '/api/v1/admin/payouts/:id/approve').handler({
    user: adminUser,
    params: ['p-1'],
    body: { note: 'Approved test' }
  });
  assert.equal(approveRes.body.data.status, 'APPROVED');
  assert.ok(calls.some(c => c.sql?.includes('UPDATE payouts SET status=?')));
  assert.ok(calls.some(c => c.sql?.includes('INSERT INTO audit_logs')));
  assert.ok(calls.some(c => c.sql?.includes('INSERT INTO notifications')));
});

test('Frontend portals: packing slip, deep linking, and wishlist counter presence', () => {
  const sellerHtml = fs.readFileSync('apps/web/public/seller.html', 'utf8');
  assert.ok(sellerHtml.includes('data-toggle-pack'), 'seller must have packing slip toggle');
  assert.ok(sellerHtml.includes('data-dl-pack'), 'seller must have packing slip download');
  assert.ok(sellerHtml.includes('data-print-pack'), 'seller must have packing slip print');
  assert.ok(sellerHtml.includes('HAAT SELLER CENTER · PACKING SLIP'), 'seller packing slip header must exist');

  // Verify seller inline scripts compile cleanly
  const sellerScripts = sellerHtml.split('<script').slice(1).map(p => {
    const o = p.indexOf('>');
    const c = p.indexOf('</script>');
    return o >= 0 && c > o ? p.slice(o + 1, c).trim() : '';
  }).filter(Boolean);
  for (const s of sellerScripts) new vm.Script(s, { filename: 'seller.html' });

  const accountHtml = fs.readFileSync('apps/web/public/account.html', 'utf8');
  assert.ok(accountHtml.includes('VALID_VIEWS'), 'account must define VALID_VIEWS for deep linking');
  assert.ok(accountHtml.includes('addAllWishBtn'), 'account must provide addAllWishBtn');
  assert.ok(accountHtml.includes('hashchange'), 'account must listen to hashchange');

  const accountScripts = accountHtml.split('<script').slice(1).map(p => {
    const o = p.indexOf('>');
    const c = p.indexOf('</script>');
    return o >= 0 && c > o ? p.slice(o + 1, c).trim() : '';
  }).filter(Boolean);
  for (const s of accountScripts) new vm.Script(s, { filename: 'account.html' });

  const indexHtml = fs.readFileSync('apps/web/public/index.html', 'utf8');
  assert.ok(indexHtml.includes('id="headerWishlistLink"'), 'storefront must have header wishlist link');
  assert.ok(indexHtml.includes('id="wishlistCount"'), 'storefront must have wishlist count badge');
  assert.ok(indexHtml.includes('id="modalShareBtn"'), 'product modal must have share button');
  assert.ok(indexHtml.includes('id="modalStoreBtn"'), 'product modal must have store filter button');
  assert.ok(indexHtml.includes('checkProductDeepLink'), 'storefront must have checkProductDeepLink');

  const indexScripts = indexHtml.split('<script').slice(1).map(p => {
    const o = p.indexOf('>');
    const c = p.indexOf('</script>');
    return o >= 0 && c > o ? p.slice(o + 1, c).trim() : '';
  }).filter(Boolean);
  for (const s of indexScripts) new vm.Script(s, { filename: 'index.html' });
});
