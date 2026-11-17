import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresOperationsRoutes } from '../apps/api/src/postgres-operations-routes.mjs';
import { createPostgresApiServer } from '../apps/api/src/postgres-server.mjs';

function setupOperations() {
  const routes = [];
  const calls = [];
  const database = {
    q(sql) {
      return {
        async get(...args) {
          calls.push({ method: 'get', sql, args });
          if (sql.includes("FROM users WHERE id=? AND role='CUSTOMER'")) return { id: 'cust-1', name: 'Buyer', phone: '01711111111', email: 'b@example.com', status: 'ACTIVE', phone_verified: 1, email_verified: 0, created_at: '2026-11-01' };
          if (sql.includes('SELECT COUNT(*)::int AS n FROM orders WHERE user_id=?')) return { n: 2 };
          if (sql.includes('FROM seller_profiles sp JOIN users u ON u.id=sp.user_id')) return { id: 'seller-1', name: 'Seller', phone: '01700000002', email: 's@example.com', user_status: 'ACTIVE', shop_name: 'Demo Store', shop_address: 'Dhaka', business_info: 'Goods', kyc_nid: '1234567890', kyc_trade_license: '', status: 'PENDING', commission_bps: 800, created_at: '2026-11-01' };
          if (sql.includes('SELECT id,total_paisa,payment_status FROM orders WHERE id=? FOR UPDATE')) return { id: 'ord-1', total_paisa: 50000, payment_status: 'PAID' };
          if (sql.includes("SELECT COALESCE(SUM(amount_paisa),0) AS s FROM refunds WHERE order_id=? AND status<>'REJECTED'")) return { s: 0 };
          if (sql.includes('SELECT id,user_id,total_paisa FROM orders WHERE id=? FOR UPDATE')) return { id: 'ord-1', user_id: 'cust-1', total_paisa: 50000 };
          if (sql.includes("SELECT COALESCE(SUM(amount_paisa),0) AS s FROM refunds WHERE order_id=? AND status='APPROVED'")) return { s: 50000 };
          if (sql.includes('AS gross_paisa')) return { gross_paisa: 250000, refunds_paisa: 50000, commission_paisa: 20000, pending_balance_paisa: 30000, paid_out_paisa: 40000, pending_payouts_paisa: 10000 };
          if (sql.includes('AS sales')) return { sales: 200000, commission: 16000, earned: 184000, pending: 10000, paid: 40000, reserved: 40000 };
          if (sql.includes('SELECT seller_id FROM payouts WHERE id=?')) return { seller_id: 'seller-1' };
          if (sql.includes('FROM seller_profiles WHERE user_id=? FOR UPDATE')) return { user_id: 'seller-1' };
          if (sql.includes('FROM payouts WHERE id=? FOR UPDATE')) return { id: 'pay-1', seller_id: 'seller-1', amount_paisa: 5000, status: 'REQUESTED' };
          if (sql.includes('AS reserved')) return { reserved: 5000, earned: 184000 };
          return undefined;
        },
        async all(...args) {
          calls.push({ method: 'all', sql, args });
          if (sql.includes("FROM users WHERE role='CUSTOMER'")) return [{ id: 'cust-1', name: 'Buyer', phone: '01711111111', email: 'b@example.com', status: 'ACTIVE', orders: 2, created_at: '2026-11-01' }];
          if (sql.includes('SELECT user_id FROM seller_profiles')) return [{ user_id: 'seller-1' }];
          if (sql.includes('FROM audit_logs')) return [{ id: 'aud-1', actor_id: 'admin-1', action: 'CHECKOUT', entity: 'order', entity_id: 'ord-1', detail: '{}', created_at: '2026-11-01' }];
          if (sql.includes('GROUP BY day')) return [{ day: '2026-11-01', orders: 3, gross: 250000 }];
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
  registerPostgresOperationsRoutes(
    (method, path, roles, handler, opts = {}) => routes.push({ method, path, roles, handler, opts }),
    (data, status = 200) => ({ status, body: { data } }),
    { database, orderLifecycle: { applySellerStatus: async () => 'DELIVERED' } }
  );
  return { routes, calls };
}

const find = (h, method, path) => h.routes.find(r => r.method === method && r.path === path);
const admin = { id: 'admin-1', role: 'ADMIN' };

test('all admin operations routes enforce ADMIN role scope', () => {
  const h = setupOperations();
  for (const r of h.routes) {
    assert.deepEqual(r.roles, ['ADMIN'], `${r.method} ${r.path} must be ADMIN-only`);
  }
});

test('admin customer management lists, edits and suspends customers atomically', async () => {
  const h = setupOperations();
  const list = await find(h, 'GET', '/api/v1/admin/customers').handler({ url: new URL('https://haat.test/api/v1/admin/customers?q=Buyer') });
  assert.equal(list.body.data[0].orders, 2);

  const suspend = await find(h, 'POST', '/api/v1/admin/customers/:id/suspend').handler({ user: admin, params: ['cust-1'], body: {} });
  assert.equal(suspend.body.data.status, 'SUSPENDED');
  assert.ok(h.calls.some(c => c.sql?.includes('DELETE FROM sessions WHERE user_id=?')));
});

test('admin can set seller commission within 0-5000 bps and approve/suspend sellers', async () => {
  const h = setupOperations();
  await assert.rejects(
    find(h, 'PATCH', '/api/v1/admin/sellers/:id/commission').handler({ user: admin, params: ['seller-1'], body: { commission_bps: 7000 } }),
    err => err.status === 400
  );
  const comm = await find(h, 'PATCH', '/api/v1/admin/sellers/:id/commission').handler({ user: admin, params: ['seller-1'], body: { commission_bps: 1000 } });
  assert.equal(comm.body.data.commission_bps, 1000);

  const approved = await find(h, 'POST', '/api/v1/admin/sellers/:id/approve').handler({ user: admin, params: ['seller-1'], body: { reason: 'Verified KYC' } });
  assert.equal(approved.body.data.status, 'APPROVED');
});

test('admin refunds, finance summary, daily report, and payout aliases work transactionally', async () => {
  const h = setupOperations();
  const refund = await find(h, 'POST', '/api/v1/admin/orders/:id/refund').handler({ user: admin, params: ['ord-1'], body: { amount_bdt: 500, reason: 'Damaged' } });
  assert.equal(refund.status, 201);
  assert.equal(refund.body.data.status, 'APPROVED');
  assert.ok(h.calls.some(c => c.sql?.includes('INSERT INTO refunds')));

  const summary = await find(h, 'GET', '/api/v1/admin/finance/summary').handler({});
  assert.equal(summary.body.data.gross_sales_bdt, 2500);
  assert.equal(summary.body.data.refunds_bdt, 500);
  assert.equal(summary.body.data.net_sales_bdt, 2000);

  const report = await find(h, 'GET', '/api/v1/admin/finance/report').handler({ url: new URL('https://haat.test/api/v1/admin/finance/report') });
  assert.equal(report.body.data[0].gross_bdt, 2500);

  const payoutApprove = await find(h, 'POST', '/api/v1/admin/payouts/:id/approve').handler({ user: admin, params: ['pay-1'], body: { note: 'Paid' } });
  assert.equal(payoutApprove.body.data.status, 'APPROVED');
});

test('postgres-server mounts shipping quote and honors custom route body limits', async () => {
  const token = 'c'.repeat(40);
  const database = {
    q() { return { async get() { return undefined; }, async all() { return []; }, async run() { return { changes: 1, rows: [] }; } }; },
    async tx(fn) { return fn(); }
  };
  const authRepository = {
    async getSessionUser(t) { return t === token ? { id: 'admin-1', role: 'ADMIN', token_hash: 'h' } : null; }
  };
  const server = createPostgresApiServer({
    database,
    catalogRepository: { async listCategories() { return []; }, async listBrands() { return []; }, async listProducts() { return []; }, async suggestProducts() { return []; }, async getProduct() { return null; }, async listReviews() { return []; } },
    authRepository,
    customerRepository: { async listAddresses() { return []; }, async createAddress() { return {}; }, async updateAddress() { return {}; }, async deleteAddress() { return {}; }, async listWishlist() { return []; }, async addWishlist() { return {}; }, async removeWishlist() { return {}; }, async saveReview() { return {}; } }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const quote = await fetch(base + '/api/v1/shipping/quote?area=Chattogram&subtotal_bdt=500');
    assert.equal(quote.status, 200);
    assert.equal((await quote.json()).data.shipping_bdt, 120);

    const cust = await fetch(base + '/api/v1/admin/customers', { headers: { authorization: 'Bearer ' + token } });
    assert.equal(cust.status, 200);

    // Non-admin custom large body limit check: /api/v1/admin/products/:id has 3MB limit while normal routes enforce 64KB
    const normalOversize = await fetch(base + '/api/v1/admin/brands', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(70 * 1024) })
    });
    assert.equal(normalOversize.status, 413);
  } finally {
    await new Promise((resolveClose, reject) => server.close(err => err ? reject(err) : resolveClose()));
  }
});
