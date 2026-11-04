import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPostgresPool, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { createPostgresCatalogRepository } from '../apps/api/src/postgres-catalog.mjs';
import { createPostgresCustomerRepository } from '../apps/api/src/postgres-customer.mjs';
import { createPostgresCheckoutRepository } from '../apps/api/src/postgres-checkout.mjs';
import { createPostgresApiServer } from '../apps/api/src/postgres-server.mjs';
import { hashPassword } from '../apps/api/src/postgres-shared.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;

test('real PostgreSQL cart HTTP lifecycle, checkout handoff and concurrency', {
  skip: !databaseUrl && 'POSTGRES_TEST_DATABASE_URL is not configured; use a disposable database', timeout: 30000
}, async t => {
  const applicationName = 'cart-integration-' + randomUUID();
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, PG_APPLICATION_NAME: applicationName };
  const pool = await createPostgresPool({ env });
  const users = [], products = [];
  let server;
  try {
    await runPostgresMigrations(pool, new URL('../apps/api/migrations/postgres/', import.meta.url).pathname);
    const database = createPostgresDatabase(pool), auth = createPostgresAuthRepository(database);
    const timestamp = new Date().toISOString(), passwordHash = hashPassword('Disposable-cart-test-123');
    async function makeUser(role) {
      const id = randomUUID(), phone = '017' + randomInt(10000000, 99999999);
      await pool.query('INSERT INTO users(id,phone,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [id, phone, 'Cart test ' + role, passwordHash, role, timestamp]);
      users.push(id);
      return { id, phone, role, token: await auth.createSession(id) };
    }
    const buyer = await makeUser('CUSTOMER'), other = await makeUser('CUSTOMER');
    const seller = await makeUser('SELLER'), admin = await makeUser('ADMIN');
    await pool.query(`INSERT INTO seller_profiles(user_id,shop_name,shop_address,status,commission_bps,created_at)
      VALUES($1,$2,'Fixture address','APPROVED',0,$3)`, [seller.id, 'Cart shop ' + seller.id, timestamp]);
    for (let i = 0; i < 51; i++) {
      const id = randomUUID();
      await pool.query(`INSERT INTO products(id,name_bn,name_en,price_paisa,discount_paisa,stock,seller_id,created_at,updated_at)
        VALUES($1,'চা','Tea',$2,$3,10,$4,$5,$5)`, [id, i === 0 ? 101 : 202, i === 0 ? 99 : null, seller.id, timestamp]);
      products.push(id);
    }
    server = createPostgresApiServer({ database, authRepository: auth,
      catalogRepository: createPostgresCatalogRepository(database), customerRepository: createPostgresCustomerRepository(database), env });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
    async function request(path = '/customer/cart', { token = buyer.token, method = 'GET', body } = {}) {
      const response = await fetch(base + path, { method,
        headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    }
    const put = (productId, quantity, options = {}) => request('/customer/cart', { method: 'PUT', body: { productId, quantity }, ...options });
    const clear = () => request('/customer/cart', { method: 'DELETE' });
    const delivery = { name: 'ক্রেতা', phone: buyer.phone, address: 'পরীক্ষার ঠিকানা', area: 'Dhaka' };
    const checkout = createPostgresCheckoutRepository(database, { shippingFor: async () => 0 }); // Explicit test-only policy, not HTTP wiring.
    const orderCount = async () => Number((await pool.query('SELECT COUNT(*) AS n FROM orders WHERE user_id=$1', [buyer.id])).rows[0].n);

    await t.test('HTTP PUT replaces quantity, ignores client pricing and returns exact BDT totals without reserving stock', async () => {
      assert.deepEqual((await request()).body.data, { items: [], subtotal_bdt: 0, item_count: 0 });
      assert.equal((await put(products[0], 3)).status, 200);
      const updated = await request('/customer/cart', { method: 'PUT', body: { productId: products[0], quantity: '2', unit_price_bdt: 0, subtotal_bdt: 0, user_id: other.id } });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.data.item_count, 2);
      assert.equal(updated.body.data.items[0].unit_price_bdt, 0.99);
      assert.equal(updated.body.data.subtotal_bdt, 1.98);
      const combined = await put(products[1], 2);
      assert.equal(combined.body.data.subtotal_bdt, 6.02);
      assert.equal(combined.body.data.item_count, 4);
      assert.equal((await request()).headers.get('cache-control'), 'no-store');
      const stock = (await pool.query('SELECT stock FROM products WHERE id=$1', [products[0]])).rows[0].stock;
      assert.equal(Number(stock), 10);
      assert.deepEqual((await request('/customer/cart', { token: other.token })).body.data.items, []);
    });

    await t.test('role boundaries, malformed inputs and excessive stock requests never overwrite a valid line', async () => {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        assert.equal((await request('/customer/cart', { method, token: null })).status, 401);
        for (const token of [seller.token, admin.token]) assert.equal((await request('/customer/cart', { method, token })).status, 403);
      }
      for (const quantity of [null, true, false, '', [], {}, 1.5, -1, 1001, '0x2']) assert.equal((await put(products[0], quantity)).status, 400);
      assert.equal((await put(products[0], 11)).status, 409);
      assert.equal((await put('unknown', 1)).status, 404);
      assert.equal((await request('/customer/cart/%ZZ', { method: 'DELETE' })).status, 400);
      const unchanged = (await request()).body.data.items.find(item => item.product_id === products[0]);
      assert.equal(unchanged.quantity, 2);
      await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [buyer.id]);
      assert.equal((await put(products[0], 1)).status, 401);
      await pool.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [buyer.id]);
    });

    await t.test('unavailable lines stay visible, stale prices refresh, and removing/clearing is owner scoped', async () => {
      await clear();
      await put(products[0], 3);
      await put(products[0], 2, { token: other.token });
      try {
        await pool.query('UPDATE products SET stock=1,price_paisa=200,discount_paisa=NULL WHERE id=$1', [products[0]]);
        const stale = (await request()).body.data.items[0];
        assert.equal(stale.available, false);
        assert.equal(stale.unit_price_bdt, 2);
        await pool.query("UPDATE seller_profiles SET status='SUSPENDED' WHERE user_id=$1", [seller.id]);
        assert.equal((await put(products[0], 1)).status, 404);
        assert.equal((await put(products[0], 0)).body.data.items.length, 0);
        assert.equal((await request('/customer/cart/' + products[0], { method: 'DELETE' })).status, 200);
        await clear();
        assert.equal((await request('/customer/cart', { token: other.token })).body.data.item_count, 2);
      } finally {
        await pool.query('UPDATE products SET stock=10,price_paisa=101,discount_paisa=99 WHERE id=$1', [products[0]]);
        await pool.query("UPDATE seller_profiles SET status='APPROVED' WHERE user_id=$1", [seller.id]);
      }
    });

    await t.test('simultaneous additions cannot exceed the fifty-product cap; existing lines remain editable', async () => {
      await clear();
      await pool.query('INSERT INTO cart_items(user_id,product_id,quantity) SELECT $1,unnest($2::text[]),1', [buyer.id, products.slice(0, 49)]);
      const results = await Promise.all([put(products[49], 1), put(products[50], 1)]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      assert.equal((await request()).body.data.items.length, 50);
      assert.equal((await put(products[0], 2)).status, 200);
      await clear();
      assert.equal((await request()).body.data.items.length, 0);
      assert.equal((await request('/customer/cart', { token: other.token })).body.data.item_count, 2);
    });

    await t.test('cart-backed repository checkout consumes persisted quantities and clears only the buyer cart', async () => {
      await put(products[0], 2);
      await put(products[1], 1);
      const created = await checkout.checkout(buyer, { delivery });
      assert.equal(created.subtotal_bdt, 4);
      const lines = (await pool.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1', [created.id])).rows;
      assert.equal(lines.length, 2);
      assert.equal(Number(lines.find(row => row.product_id === products[0]).quantity), 2);
      assert.deepEqual((await request()).body.data.items, []);
      assert.equal((await request('/customer/cart', { token: other.token })).body.data.item_count, 2);
    });

    await t.test('missing shipping policy and rejected stock validation leave carts and orders intact', async () => {
      await put(products[0], 2);
      const before = await orderCount();
      const unconfigured = createPostgresCheckoutRepository(database);
      await assert.rejects(unconfigured.checkout(buyer, { delivery }), error => error.status === 503);
      assert.equal((await request()).body.data.item_count, 2);
      const priorStock = (await pool.query('SELECT stock FROM products WHERE id=$1', [products[0]])).rows[0].stock;
      try {
        await pool.query('UPDATE products SET stock=1 WHERE id=$1', [products[0]]);
        await assert.rejects(checkout.checkout(buyer, { delivery }), error => error.status === 409);
        assert.equal((await request()).body.data.item_count, 2);
        assert.equal(await orderCount(), before);
      } finally { await pool.query('UPDATE products SET stock=$1 WHERE id=$2', [priorStock, products[0]]); }
    });

    await t.test('a late checkout failure rolls back stock reservation, order/payment rows and cart cleanup together', async () => {
      await clear();
      await put(products[0], 2);
      const before = await orderCount();
      const priorStock = (await pool.query('SELECT stock FROM products WHERE id=$1', [products[0]])).rows[0].stock;
      const failingCheckout = createPostgresCheckoutRepository(database, {
        shippingFor: async () => 0,
        audit: async () => { throw new Error('Injected post-cleanup audit failure'); }
      });
      await assert.rejects(failingCheckout.checkout(buyer, { delivery }), /Injected post-cleanup audit failure/);
      assert.equal(await orderCount(), before);
      assert.equal((await request()).body.data.item_count, 2);
      assert.equal((await pool.query('SELECT stock FROM products WHERE id=$1', [products[0]])).rows[0].stock, priorStock);
      const payments = await pool.query('SELECT COUNT(*) AS n FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.user_id=$1', [buyer.id]);
      assert.equal(Number(payments.rows[0].n), before);
    });

    await t.test('cart edit waits for checkout and survives its cleanup instead of being silently discarded', async () => {
      await clear();
      await put(products[0], 1);
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const reachedShipping = new Promise(resolve => { entered = resolve; });
      const gatedCheckout = createPostgresCheckoutRepository(database, { shippingFor: async () => { entered(); await gate; return 0; } });
      const placing = gatedCheckout.checkout(buyer, { delivery });
      // Surface early checkout failures rather than waiting forever for the gate.
      await Promise.race([reachedShipping, placing.then(() => { throw new Error('Checkout did not enter shipping gate'); })]);
      const editing = put(products[1], 2);
      let outcomes;
      try {
        // Observe a real PostgreSQL lock wait, not a timing-only JS mock.
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          const result = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1
            AND wait_event_type='Lock' AND query LIKE '%FROM users%'`, [applicationName]);
          if (result.rows.length) { waiting = true; break; }
          await delay(10);
        }
        assert.ok(waiting, 'cart PUT must wait on checkout customer lock');
      } finally {
        release();
        outcomes = await Promise.all([placing, editing]);
      }
      const [order, edited] = outcomes;
      assert.equal(edited.status, 200);
      assert.deepEqual(edited.body.data.items.map(item => [item.product_id, item.quantity]), [[products[1], 2]]);
      const ordered = (await pool.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1', [order.id])).rows;
      assert.equal(ordered.length, 1);
      assert.equal(ordered[0].product_id, products[0]);
      assert.equal(Number(ordered[0].quantity), 1);
    });

    await t.test('two simultaneous cart checkouts cannot both consume the same cart snapshot', async () => {
      await clear();
      await put(products[0], 1);
      const before = await orderCount();
      const outcomes = await Promise.allSettled([checkout.checkout(buyer, { delivery }), checkout.checkout(buyer, { delivery })]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      const rejected = outcomes.find(result => result.status === 'rejected');
      assert.equal(rejected.reason.status, 400);
      assert.match(rejected.reason.message, /Cart must contain/);
      assert.equal(await orderCount(), before + 1);
      assert.equal((await request()).body.data.items.length, 0);
    });
  } finally {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await pool.query('DELETE FROM orders WHERE user_id=ANY($1::text[])', [users]);
      await pool.query('DELETE FROM products WHERE id=ANY($1::text[])', [products]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
    } finally { await closePostgresPool(pool); }
  }
});
