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
test('real PostgreSQL coupon preview, checkout redemption, rollback and lock contention', {
  skip: !databaseUrl && 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL required', timeout: 30000
}, async t => {
  const applicationName = 'coupon-test-' + randomUUID();
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, PG_APPLICATION_NAME: applicationName };
  const pool = await createPostgresPool({ env });
  const users = [], products = [], codes = [];
  let server;
  try {
    await runPostgresMigrations(pool, new URL('../apps/api/migrations/postgres/', import.meta.url).pathname);
    const database = createPostgresDatabase(pool), auth = createPostgresAuthRepository(database), cart = createPostgresCartRepository(database);
    const timestamp = new Date().toISOString(), password = hashPassword('Disposable-coupon-fixture-123');
    async function makeUser(role) {
      const user = { id: randomUUID(), phone: '017' + randomInt(10000000, 99999999), role };
      await pool.query('INSERT INTO users(id,phone,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [user.id, user.phone, 'Coupon fixture', password, role, timestamp]);
      users.push(user.id);
      return { ...user, token: await auth.createSession(user.id) };
    }
    const buyer = await makeUser('CUSTOMER'), other = await makeUser('CUSTOMER'), seller = await makeUser('SELLER'), admin = await makeUser('ADMIN');
    await pool.query(`INSERT INTO seller_profiles(user_id,shop_name,shop_address,status,commission_bps,created_at)
      VALUES($1,$2,'Fixture address','APPROVED',0,$3)`, [seller.id, 'Coupon shop ' + seller.id, timestamp]);
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      await pool.query(`INSERT INTO products(id,name_bn,name_en,price_paisa,stock,seller_id,created_at,updated_at)
        VALUES($1,'চা','Tea',1001,20,$2,$3,$3)`, [id, seller.id, timestamp]);
      products.push(id);
    }
    async function makeCoupon({ type = 'FIXED', value = 500, minimum = 0, maximum = null, expires = null } = {}) {
      const code = 'CP' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
      await pool.query('INSERT INTO coupons(code,type,value,min_order_paisa,max_uses,used_count,expires_at,active) VALUES($1,$2,$3,$4,$5,0,$6,1)',
        [code, type, value, minimum, maximum, expires]);
      codes.push(code);
      return code;
    }
    const fixed = await makeCoupon({ minimum: 1000 }), percent = await makeCoupon({ type: 'PERCENT', value: 17 });
    const delivery = user => ({ name: 'ক্রেতা', phone: user.phone, address: 'পরীক্ষার ঠিকানা', area: 'Dhaka' });
    // Explicit fixture-only shipping. Does not wire or bypass the HTTP policy gate.
    const checkout = createPostgresCheckoutRepository(database, { shippingFor: async () => 123 });
    const place = (repo, user, code) => repo.checkout(user, { delivery: delivery(user), coupon_code: code });
    const used = async code => Number((await pool.query('SELECT used_count FROM coupons WHERE code=$1', [code])).rows[0].used_count);
    async function snapshot(user, code, productId = products[0]) {
      return {
        used: await used(code), cart: await cart.getCart(user.id),
        stock: Number((await pool.query('SELECT stock FROM products WHERE id=$1', [productId])).rows[0].stock),
        orders: Number((await pool.query('SELECT COUNT(*) AS n FROM orders WHERE user_id=$1', [user.id])).rows[0].n),
        payments: Number((await pool.query('SELECT COUNT(*) AS n FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.user_id=$1', [user.id])).rows[0].n)
      };
    }
    async function waitForCouponLock() {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%FROM coupons%'`, [applicationName]);
        if (result.rows.length) return;
        await delay(10);
      }
      assert.fail('Expected a real PostgreSQL coupon row-lock wait');
    }
    server = createPostgresApiServer({ database, authRepository: auth, catalogRepository: createPostgresCatalogRepository(database), customerRepository: createPostgresCustomerRepository(database), env });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    async function preview(body, token = buyer.token) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/coupons/validate', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json(), headers: response.headers };
    }

    await t.test('HTTP preview enforces roles and uses only the signed-in saved cart, ignoring forged prices and ownership', async () => {
      assert.equal((await preview({ code: fixed }, null)).status, 401);
      for (const token of [seller.token, admin.token]) assert.equal((await preview({ code: fixed }, token)).status, 403);
      await cart.setItemQuantity(buyer.id, products[0], 2);
      assert.equal((await preview({ code: fixed, subtotal_bdt: 99999 }, other.token)).status, 400);
      const quote = await preview({ code: ' ' + fixed.toLowerCase() + ' ', subtotal_bdt: 0, user_id: other.id, discount_bdt: 99999 });
      assert.equal(quote.status, 200);
      assert.equal(quote.headers.get('cache-control'), 'no-store');
      assert.deepEqual(quote.body.data, { code: fixed, discount_bdt: 5, subtotal_bdt: 20.02 });
      await preview({ code: fixed });
      assert.equal(await used(fixed), 0, 'previews must not reserve redemptions');
      const minimum = await makeCoupon({ minimum: 5000 });
      assert.equal((await preview({ code: minimum, subtotal_bdt: 99999 })).status, 400);
    });

    await t.test('missing/disabled/expired coupons and unavailable cart lines are rejected without consumption', async () => {
      assert.equal((await preview({ code: 'MISSING' })).status, 400);
      assert.equal((await preview({})).status, 400);
      const expired = await makeCoupon({ expires: '2000-01-01T00:00:00Z' });
      assert.equal((await preview({ code: expired })).status, 400);
      await pool.query('UPDATE coupons SET active=0 WHERE code=$1', [expired]);
      assert.equal((await preview({ code: expired })).status, 400);
      try {
        await pool.query('UPDATE products SET stock=0 WHERE id=$1', [products[0]]);
        assert.equal((await preview({ code: fixed })).status, 409);
        assert.equal(await used(fixed), 0);
      } finally { await pool.query('UPDATE products SET stock=20 WHERE id=$1', [products[0]]); }
    });

    await t.test('default checkout validator persists fixed discounts and increments usage exactly once with the order', async () => {
      const created = await place(checkout, buyer, fixed.toLowerCase());
      assert.equal(created.subtotal_bdt, 20.02);
      assert.equal(created.discount_bdt, 5);
      assert.equal(created.shipping_bdt, 1.23);
      assert.equal(created.total_bdt, 16.25);
      assert.equal(await used(fixed), 1);
      const order = (await pool.query('SELECT coupon_code,discount_paisa,total_paisa FROM orders WHERE id=$1', [created.id])).rows[0];
      assert.equal(order.coupon_code, fixed);
      assert.equal(Number(order.discount_paisa), 500);
      assert.equal(Number(order.total_paisa), 1625);
      assert.equal(Number((await pool.query('SELECT amount_paisa FROM payments WHERE order_id=$1', [created.id])).rows[0].amount_paisa), 1625);
      assert.equal((await cart.getCart(buyer.id)).items.length, 0);
    });

    await t.test('percentage checkout rounds down to paisa while fixed discount never discounts shipping', async () => {
      await cart.setItemQuantity(buyer.id, products[0], 2);
      const percentage = await place(checkout, buyer, percent);
      assert.equal(percentage.discount_bdt, 3.4); // floor(2002 * 17 / 100) = 340
      assert.equal(percentage.total_bdt, 17.85);
      const capped = await makeCoupon({ value: 999999 });
      await cart.setItemQuantity(buyer.id, products[0], 1);
      const freeItems = await place(checkout, buyer, capped);
      assert.equal(freeItems.discount_bdt, 10.01);
      assert.equal(freeItems.total_bdt, 1.23);
    });

    await t.test('a successful preview is not a reservation: checkout revalidates exhaustion and changed server prices', async () => {
      const once = await makeCoupon({ maximum: 1 });
      await cart.setItemQuantity(buyer.id, products[0], 2);
      assert.equal((await preview({ code: once })).status, 200);
      await pool.query('UPDATE coupons SET used_count=1 WHERE code=$1', [once]);
      const before = await snapshot(buyer, once);
      await assert.rejects(place(checkout, buyer, once), error => error.status === 400);
      assert.deepEqual(await snapshot(buyer, once), before);
      assert.equal((await preview({ code: fixed })).status, 200);
      try {
        await pool.query('UPDATE products SET price_paisa=200 WHERE id=$1', [products[0]]);
        const changed = await snapshot(buyer, fixed);
        await assert.rejects(place(checkout, buyer, fixed), error => error.status === 400 && /minimum/.test(error.message));
        assert.deepEqual(await snapshot(buyer, fixed), changed);
      } finally { await pool.query('UPDATE products SET price_paisa=1001 WHERE id=$1', [products[0]]); }
    });

    await t.test('failure after coupon consumption and cart cleanup rolls back usage, stock, payments and order together', async () => {
      const before = await snapshot(buyer, fixed);
      const failing = createPostgresCheckoutRepository(database, { shippingFor: async () => 123, audit: async () => { throw new Error('Injected post-redemption failure'); } });
      await assert.rejects(place(failing, buyer, fixed), /Injected post-redemption failure/);
      assert.deepEqual(await snapshot(buyer, fixed), before);
    });

    await t.test('different buyers with different products cannot both redeem the last coupon use', async () => {
      const last = await makeCoupon({ maximum: 1 });
      await cart.setItemQuantity(buyer.id, products[0], 1);
      await cart.setItemQuantity(other.id, products[1], 1);
      const otherBefore = await snapshot(other, last, products[1]);
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const atShipping = new Promise(resolve => { entered = resolve; });
      const gated = createPostgresCheckoutRepository(database, { shippingFor: async () => { entered(); await gate; return 123; } });
      const first = place(gated, buyer, last);
      await Promise.race([atShipping, first.then(() => { throw new Error('Checkout did not reach shipping gate'); })]);
      const second = place(checkout, other, last);
      const all = Promise.allSettled([first, second]);
      let results;
      try { await waitForCouponLock(); }
      finally { release(); results = await all; }
      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[1].status, 'rejected');
      assert.equal(results[1].reason.status, 400);
      assert.equal(await used(last), 1);
      const otherAfter = await snapshot(other, last, products[1]);
      assert.deepEqual(otherAfter, { ...otherBefore, used: 1 });
    });

    await t.test('a coupon expiring while checkout waits for its row lock is rejected after the lock releases', async () => {
      const code = await makeCoupon({ expires: '2030-01-01T00:00:00Z' });
      await cart.setItemQuantity(buyer.id, products[0], 1);
      const before = await snapshot(buyer, code);
      let clock = '2029-12-31T23:59:59.000Z';
      const timed = createPostgresCheckoutRepository(database, { shippingFor: async () => 123, now: () => clock });
      const blocker = await pool.connect();
      let outcome;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT code FROM coupons WHERE code=$1 FOR UPDATE', [code]);
        const attempt = place(timed, buyer, code);
        outcome = Promise.allSettled([attempt]);
        await waitForCouponLock();
        clock = '2030-01-01T00:00:00.000Z';
      } finally {
        try { await blocker.query('ROLLBACK'); } finally { blocker.release(); }
        // Drain the waiting checkout even when the lock-observation assertion fails.
        if (outcome) await outcome;
      }
      const [result] = await outcome;
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.status, 400);
      assert.deepEqual(await snapshot(buyer, code), before);
    });
    await t.test('per-customer redemption limit is enforced in preview and serialized checkout but does not block another customer', async () => {
      const limited = await makeCoupon();
      await pool.query('UPDATE coupons SET max_uses_per_customer=1 WHERE code=$1', [limited]);
      await cart.setItemQuantity(buyer.id, products[1], 1);
      const first = await place(checkout, buyer, limited);
      assert.equal(first.discount_bdt, 5);
      await cart.setItemQuantity(buyer.id, products[1], 1);
      assert.equal((await preview({ code: limited })).status, 400);
      await assert.rejects(place(checkout, buyer, limited), error => error.status === 400);
      assert.equal(await used(limited), 1);
      await cart.setItemQuantity(other.id, products[1], 1);
      const otherPreview = await preview({ code: limited }, other.token);
      assert.equal(otherPreview.status, 200);
      const second = await place(checkout, other, limited);
      assert.equal(second.discount_bdt, 5);
      assert.equal(await used(limited), 2);
    });
  } finally {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await pool.query('DELETE FROM orders WHERE user_id=ANY($1::text[])', [users]);
      await pool.query('DELETE FROM coupons WHERE code=ANY($1::text[])', [codes]);
      await pool.query('DELETE FROM products WHERE id=ANY($1::text[])', [products]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
    } finally { await closePostgresPool(pool); }
  }
});
