import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPostgresPool, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { createPostgresCatalogRepository } from '../apps/api/src/postgres-catalog.mjs';
import { createPostgresCustomerRepository } from '../apps/api/src/postgres-customer.mjs';
import { createPostgresCartRepository } from '../apps/api/src/postgres-cart.mjs';
import { createPostgresCheckoutRepository } from '../apps/api/src/postgres-checkout.mjs';
import { createPostgresApiServer } from '../apps/api/src/postgres-server.mjs';
import { hashPassword } from '../apps/api/src/postgres-shared.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
test('real PostgreSQL admin coupon HTTP administration, audits and redemption coordination', {
  skip: !databaseUrl && 'POSTGRES_TEST_DATABASE_URL is not configured; disposable database required', timeout: 30000
}, async t => {
  const appName = 'admin-coupon-' + randomUUID();
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, PG_APPLICATION_NAME: appName };
  const pool = await createPostgresPool({ env });
  const users = [], products = [], codes = new Set(), auditHooks = new Map();
  let server;
  try {
    await runPostgresMigrations(pool, new URL('../apps/api/migrations/postgres/', import.meta.url).pathname);
    const baseDatabase = createPostgresDatabase(pool);
    // Fault/barrier injection surrounds real SQL: transaction rollback and row
    // locks are exercised against PostgreSQL, not simulated in memory.
    const database = { ...baseDatabase, q(sql) {
      const statement = baseDatabase.q(sql);
      if (!sql.startsWith('INSERT INTO audit_logs')) return statement;
      return { ...statement, async run(...args) { await auditHooks.get(args[4])?.(); return statement.run(...args); } };
    } };
    const auth = createPostgresAuthRepository(database), cart = createPostgresCartRepository(database);
    const password = hashPassword('Disposable-admin-coupon-123'), timestamp = new Date().toISOString();
    async function makeUser(role) {
      const user = { id: randomUUID(), phone: '017' + randomInt(10000000, 99999999), role };
      await pool.query('INSERT INTO users(id,phone,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)', [user.id, user.phone, 'Coupon fixture', password, role, timestamp]);
      users.push(user.id);
      return { ...user, token: await auth.createSession(user.id) };
    }
    const admin = await makeUser('ADMIN'), secondAdmin = await makeUser('ADMIN'), buyer = await makeUser('CUSTOMER'), seller = await makeUser('SELLER');
    await pool.query(`INSERT INTO seller_profiles(user_id,shop_name,shop_address,status,commission_bps,created_at)
      VALUES($1,$2,'Fixture address','APPROVED',0,$3)`, [seller.id, 'Admin coupon fixture ' + seller.id, timestamp]);
    const productId = randomUUID();
    await pool.query(`INSERT INTO products(id,name_bn,name_en,price_paisa,stock,seller_id,created_at,updated_at)
      VALUES($1,'চা','Tea',1001,20,$2,$3,$3)`, [productId, seller.id, timestamp]);
    products.push(productId);
    server = createPostgresApiServer({ database, authRepository: auth, catalogRepository: createPostgresCatalogRepository(database), customerRepository: createPostgresCustomerRepository(database), env });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
    async function request(path, { method = 'GET', token = admin.token, body } = {}) {
      const response = await fetch(base + path, { method,
        headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json(), headers: response.headers };
    }
    const newCode = () => { const code = 'AC' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase(); codes.add(code); return code; };
    const create = (code, body = {}, token = admin.token) => request('/admin/coupons', { method: 'POST', token, body: { code, type: 'FIXED', value: '1.00', ...body } });
    const toggle = (code, active, token = admin.token) => request('/admin/coupons/' + code, { method: 'PATCH', token, body: { active } });
    const preview = code => request('/coupons/validate', { method: 'POST', token: buyer.token, body: { code } });
    const saved = async code => (await pool.query('SELECT * FROM coupons WHERE code=$1', [code])).rows[0];
    const audits = async code => (await pool.query("SELECT actor_id,action,detail FROM audit_logs WHERE entity='coupon' AND entity_id=$1 ORDER BY created_at,id", [code])).rows;
    const checkout = createPostgresCheckoutRepository(database, { shippingFor: async () => 0 }); // Test-only policy, not HTTP shipping wiring.
    const place = (repo, code) => repo.checkout(buyer, { coupon_code: code, delivery: { name: 'ক্রেতা', phone: buyer.phone, address: 'পরীক্ষার ঠিকানা', area: 'Dhaka' } });
    async function waitForCouponLock() {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%FROM coupons%'", [appName]);
        if (waiting.rows.length) return;
        await delay(10);
      }
      assert.fail('Expected real coupon row-lock contention');
    }
    const fixed = newCode();

    await t.test('all administration methods require active ADMIN sessions, not customer or seller roles', async () => {
      for (const [method, path] of [['GET', '/admin/coupons'], ['POST', '/admin/coupons'], ['PATCH', '/admin/coupons/' + fixed]]) {
        assert.equal((await request(path, { method, token: null })).status, 401);
        for (const token of [buyer.token, seller.token]) assert.equal((await request(path, { method, token })).status, 403);
      }
      await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [secondAdmin.id]);
      assert.equal((await create(fixed, {}, secondAdmin.token)).status, 401);
      await pool.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [secondAdmin.id]);
      assert.equal(await saved(fixed), undefined);
    });

    await t.test('create/list preserves contract units, exact decimal BDT and audit actor attribution', async () => {
      const created = await create(' ' + fixed.toLowerCase() + ' ', { value: '0.29', min_order_bdt: '1.01', max_uses: '2', expires_at: '2030-01-02T06:00:00+06:00', active: false });
      assert.equal(created.status, 201);
      assert.deepEqual(created.body, { data: { code: fixed } });
      const list = await request('/admin/coupons?active=0&limit=100');
      assert.equal(list.status, 200);
      assert.equal(list.headers.get('cache-control'), 'no-store');
      assert.ok(list.body.data.every(row => row.active === 0));
      const item = list.body.data.find(row => row.code === fixed);
      assert.equal(item.value, 29);
      assert.equal(item.value_bdt, 0.29);
      assert.equal(item.min_order_paisa, 101);
      assert.equal(item.min_order_bdt, 1.01);
      assert.equal(item.expires_at, '2030-01-02T00:00:00.000Z');
      const audit = (await audits(fixed))[0];
      assert.equal(audit.actor_id, admin.id);
      assert.equal(audit.action, 'COUPON_CREATE');
      assert.equal(JSON.parse(audit.detail).value, 29);
      assert.equal((await request('/admin/coupons?limit=1&offset=0')).body.data.length, 1);
      for (const query of ['limit=301', 'offset=10001', 'active=false']) assert.equal((await request('/admin/coupons?' + query)).status, 400);
    });

    await t.test('activation controls customer preview and same-state repeats do not duplicate audit events', async () => {
      await cart.setItemQuantity(buyer.id, productId, 1);
      assert.equal((await preview(fixed)).status, 400);
      assert.equal((await toggle(fixed.toLowerCase(), true)).status, 200);
      assert.equal((await preview(fixed)).body.data.discount_bdt, 0.29);
      assert.equal((await toggle(fixed, false)).status, 200);
      assert.equal((await preview(fixed)).status, 400);
      const count = (await audits(fixed)).length;
      await toggle(fixed, false);
      assert.equal((await audits(fixed)).length, count);
      assert.equal(Number((await saved(fixed)).used_count), 0);
      await toggle(fixed, true);
    });

    await t.test('malformed amounts, dates and privileged fields cannot create coupons or reset usage', async () => {
      const code = newCode();
      for (const body of [{ value: '1.005' }, { value: false }, { type: 'OTHER' }, { max_uses: 0 }, { used_count: 0 }, { actor_id: secondAdmin.id }, { expires_at: '2000-01-01' }, { expires_at: '2030-02-30' }]) {
        assert.equal((await create(code, body)).status, 400);
      }
      assert.equal(await saved(code), undefined);
      assert.equal((await audits(code)).length, 0);
      for (const body of [{ active: 'false' }, { active: true, used_count: 0 }, { active: true, value: '99' }]) {
        assert.equal((await request('/admin/coupons/' + fixed, { method: 'PATCH', body })).status, 400);
      }
      assert.equal((await toggle('MISSING_COUPON', false)).status, 404);
      assert.equal((await request('/admin/coupons/%ZZ', { method: 'PATCH', body: { active: false } })).status, 400);
    });

    await t.test('concurrent normalized duplicate creation creates exactly one coupon and one audit', async () => {
      const code = newCode();
      const results = await Promise.all([create(code.toLowerCase(), { value: '1.00' }), create(' ' + code + ' ', { value: '2.00' }, secondAdmin.token)]);
      assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
      const winner = results.findIndex(result => result.status === 201);
      assert.equal(Number((await saved(code)).value), winner === 0 ? 100 : 200);
      const records = await audits(code);
      assert.equal(records.length, 1);
      assert.equal(records[0].actor_id, winner === 0 ? admin.id : secondAdmin.id);
    });

    await t.test('audit-write failures roll back HTTP creation and toggling without exposing internal errors', async () => {
      const failing = newCode();
      const fail = async () => { throw new Error('INJECTED_PRIVATE_AUDIT_FAILURE'); };
      auditHooks.set(failing, fail);
      try {
        const result = await create(failing);
        assert.equal(result.status, 500);
        assert.deepEqual(result.body, { error: 'Internal server error' });
        assert.equal(await saved(failing), undefined);
        assert.equal((await audits(failing)).length, 0);
      } finally { auditHooks.delete(failing); }
      const before = await saved(fixed), auditCount = (await audits(fixed)).length;
      auditHooks.set(fixed, fail);
      try {
        assert.equal((await toggle(fixed, false)).status, 500);
        assert.deepEqual(await saved(fixed), before);
        assert.equal((await audits(fixed)).length, auditCount);
      } finally { auditHooks.delete(fixed); }
    });

    await t.test('admin-created percentage coupons redeem correctly; exhausted and expired coupons cannot be re-enabled', async () => {
      const percent = newCode();
      assert.equal((await create(percent, { type: 'PERCENT', value: 17, max_uses: 1 })).status, 201);
      await cart.setItemQuantity(buyer.id, productId, 1);
      const order = await place(checkout, percent);
      assert.equal(order.discount_bdt, 1.7);
      assert.equal(order.total_bdt, 8.31);
      assert.equal(Number((await saved(percent)).used_count), 1);
      assert.equal((await toggle(percent, false)).status, 200);
      assert.equal((await toggle(percent, true)).status, 409);
      assert.equal(Number((await saved(percent)).used_count), 1);
      const expired = newCode();
      await create(expired, { active: false, expires_at: '2030-01-01T00:00:00Z' });
      await pool.query("UPDATE coupons SET expires_at='2000-01-01T00:00:00Z' WHERE code=$1", [expired]); // Simulate passage of time in fixture data.
      assert.equal((await toggle(expired, true)).status, 409);
      assert.equal((await toggle(expired, false)).status, 200);
    });

    await t.test('two admins disabling concurrently produce one transition audit and preserve usage', async () => {
      const code = newCode();
      await create(code);
      const results = await Promise.all([toggle(code, false), toggle(code, false, secondAdmin.token)]);
      assert.deepEqual(results.map(result => result.status), [200, 200]);
      assert.equal((await audits(code)).filter(record => record.action === 'COUPON_TOGGLE').length, 1);
      assert.equal(Number((await saved(code)).used_count), 0);
    });

    await t.test('disable waits for an already locked checkout, then preserves its committed redemption count', async () => {
      const code = newCode();
      await create(code, { max_uses: 3 });
      await cart.setItemQuantity(buyer.id, productId, 1);
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; }), atShipping = new Promise(resolve => { entered = resolve; });
      const gated = createPostgresCheckoutRepository(database, { shippingFor: async () => { entered(); await gate; return 0; } });
      const placing = place(gated, code);
      await Promise.race([atShipping, placing.then(() => { throw new Error('Missing checkout gate'); })]);
      const disabling = toggle(code, false), outcomes = Promise.allSettled([placing, disabling]);
      let results;
      try { await waitForCouponLock(); } finally { release(); results = await outcomes; }
      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[1].value.status, 200);
      const row = await saved(code);
      assert.equal(Number(row.active), 0);
      assert.equal(Number(row.used_count), 1);
      await cart.setItemQuantity(buyer.id, productId, 1);
      await assert.rejects(place(checkout, code), error => error.status === 400);
      assert.equal(Number((await saved(code)).used_count), 1);
    });

    await t.test('checkout waits for a pending disable and rejects the coupon after the admin transaction commits', async () => {
      const code = newCode();
      await create(code);
      await cart.setItemQuantity(buyer.id, productId, 1);
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; }), atAudit = new Promise(resolve => { entered = resolve; });
      auditHooks.set(code, async () => { entered(); await gate; });
      const disabling = toggle(code, false);
      let results;
      try {
        await Promise.race([atAudit, disabling.then(() => { throw new Error('Missing admin audit gate'); })]);
        const placing = place(checkout, code), outcomes = Promise.allSettled([disabling, placing]);
        try { await waitForCouponLock(); } finally { release(); results = await outcomes; }
      } finally { release(); auditHooks.delete(code); }
      assert.equal(results[0].value.status, 200);
      assert.equal(results[1].status, 'rejected');
      assert.equal(results[1].reason.status, 400);
      assert.equal(Number((await saved(code)).used_count), 0);
      assert.equal((await cart.getCart(buyer.id)).item_count, 1);
    });
  } finally {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await pool.query('DELETE FROM audit_logs WHERE actor_id=ANY($1::text[])', [users]);
      await pool.query('DELETE FROM orders WHERE user_id=ANY($1::text[])', [users]);
      await pool.query('DELETE FROM coupons WHERE code=ANY($1::text[])', [[...codes]]);
      await pool.query('DELETE FROM products WHERE id=ANY($1::text[])', [products]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
    } finally { await closePostgresPool(pool); }
  }
});
