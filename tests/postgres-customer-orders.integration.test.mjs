import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
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

test('real PostgreSQL customer orders and shared-method product HTTP workflows', {
  skip: !databaseUrl && 'POSTGRES_TEST_DATABASE_URL is not configured; use a disposable PostgreSQL database'
}, async t => {
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl };
  const pool = await createPostgresPool({ env });
  const users = [], products = [], orderIds = [];
  let server;
  try {
    await runPostgresMigrations(pool, new URL('../apps/api/migrations/postgres/', import.meta.url).pathname);
    const database = createPostgresDatabase(pool);
    const auth = createPostgresAuthRepository(database);
    const timestamp = '2026-11-04T00:00:00.000Z';
    const fixturePassword = 'Disposable-test-only-123';
    const passwordHash = hashPassword(fixturePassword);
    async function createUser(role) {
      const user = { id: randomUUID(), role, phone: '017' + randomInt(10000000, 99999999) };
      await pool.query(`INSERT INTO users(id,phone,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
        [user.id, user.phone, 'Order test ' + role, passwordHash, role, timestamp]);
      users.push(user.id);
      if (role === 'SELLER') await pool.query(`INSERT INTO seller_profiles(user_id,shop_name,shop_address,status,commission_bps,created_at)
        VALUES($1,$2,'Test address','APPROVED',0,$3)`, [user.id, 'Order test shop ' + user.id, timestamp]);
      return { ...user, token: await auth.createSession(user.id) };
    }
    const buyer = await createUser('CUSTOMER'), other = await createUser('CUSTOMER');
    const seller = await createUser('SELLER'), secondSeller = await createUser('SELLER');
    const admin = await createUser('ADMIN');
    const category = (await pool.query('SELECT id,slug FROM categories ORDER BY id LIMIT 1')).rows[0];
    assert.ok(category);
    for (const [owner, price] of [[seller, 10025], [secondSeller, 15075]]) {
      const productId = randomUUID();
      await pool.query(`INSERT INTO products(id,category_id,name_bn,name_en,price_paisa,stock,seller_id,created_at,updated_at)
        VALUES($1,$2,'চা','Tea',$3,10,$4,$5,$5)`, [productId, category.id, price, owner.id, timestamp]);
      products.push(productId);
    }
    // This explicit fixture-only fee is NOT a business policy or HTTP checkout
    // integration. Missing shipping policy in server composition remains blocked.
    const checkout = createPostgresCheckoutRepository(database, { shippingFor: async () => 1250 });
    const created = await checkout.checkout(buyer, {
      delivery: { name: 'ক্রেতা', phone: buyer.phone, address: 'পরীক্ষার ঠিকানা', area: 'Dhaka', note: 'Call on arrival' },
      items: [{ productId: products[0], quantity: 2 }, { productId: products[1], quantity: 1 }], payment_method: 'COD'
    });
    orderIds.push(created.id);
    await pool.query('UPDATE orders SET admin_note=$1 WHERE id=$2', ['PRIVATE ADMIN NOTE', created.id]);
    const subs = (await pool.query('SELECT id,seller_id FROM seller_orders WHERE order_id=$1 ORDER BY id', [created.id])).rows;
    assert.equal(subs.length, 2);
    const sellerSub = subs.find(row => row.seller_id === seller.id);
    // Courier records are test fixtures, not actual carrier dispatches. Equal
    // timestamps exercise the deterministic ID tie-breaker for the latest row.
    for (const suffix of ['a', 'b']) await pool.query(`INSERT INTO shipments(id,seller_order_id,provider,tracking_id,status,charge_paisa,mode,created_at)
      VALUES($1,$2,'TEST_COURIER',$3,'CREATED',1234,'sandbox',$4)`,
      [created.id + suffix, sellerSub.id, created.id + '-TRACK-' + suffix, timestamp]);
    for (const [suffix, status] of [['b', 'PROCESSING'], ['a', 'CONFIRMED']]) await pool.query(`INSERT INTO order_events(id,order_id,status,note,actor_id,created_at)
      VALUES($1,$2,$3,'PRIVATE EVENT NOTE',$4,$5)`, [created.id + suffix, created.id, status, admin.id, timestamp]);
    await pool.query("UPDATE payments SET raw='PRIVATE PAYMENT PAYLOAD',gateway_txn_id='PRIVATE GATEWAY REFERENCE' WHERE order_id=$1", [created.id]);

    server = createPostgresApiServer({ database, authRepository: auth,
      catalogRepository: createPostgresCatalogRepository(database), customerRepository: createPostgresCustomerRepository(database), env });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port;
    async function request(path, { token = buyer.token, method = 'GET', body } = {}) {
      const response = await fetch(base + '/api/v1' + path, { method,
        headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    }
    const orderPath = '/customer/orders/' + created.id;

    await t.test('real login and customer order history/detail preserve checkout snapshots and BDT amounts', async () => {
      const login = await request('/auth/login', { token: null, method: 'POST', body: { identifier: buyer.phone, password: fixturePassword } });
      assert.equal(login.status, 200);
      assert.equal(login.body.data.id, buyer.id);
      assert.equal((await request('/customer/orders')).body.data.some(row => row.id === created.id), true);
      const detail = await request(orderPath, { token: login.body.token });
      assert.equal(detail.status, 200);
      assert.equal(detail.headers.get('cache-control'), 'no-store');
      const data = detail.body.data;
      assert.equal(data.total_bdt, 363.75);
      assert.equal(data.subtotal_bdt, 351.25);
      assert.equal(data.shipping_bdt, 12.5);
      assert.equal(data.delivery.address, 'পরীক্ষার ঠিকানা');
      assert.equal(data.delivery.note, 'Call on arrival');
      assert.deepEqual(data.payment, { method: 'COD', status: 'PENDING' });
      assert.equal(data.items.length, 2);
      assert.equal(data.items.find(item => item.product_id === products[0]).quantity, 2);
      assert.equal(data.items.find(item => item.product_id === products[0]).unit_price_bdt, 100.25);
      assert.equal(data.suborders.length, 2);
      assert.equal(data.suborders.find(sub => sub.id === sellerSub.id).shipment.tracking_id, created.id + '-TRACK-b');
      assert.equal(data.suborders.find(sub => sub.id !== sellerSub.id).shipment, null);
      assert.doesNotMatch(JSON.stringify(data), /PRIVATE|admin_note|commission|net_paisa|raw|gateway_txn_id/);
    });

    await t.test('tracking events are deterministic and sandbox shipments remain explicit without private notes', async () => {
      const response = await request(orderPath + '/tracking');
      assert.equal(response.status, 200);
      const data = response.body.data;
      assert.deepEqual(data.events.map(event => event.status), ['CONFIRMED', 'PROCESSING']);
      assert.equal(data.shipments.length, 2);
      assert.ok(data.shipments.every(shipment => shipment.mode === 'sandbox' && shipment.seller_order_id === sellerSub.id));
      assert.doesNotMatch(JSON.stringify(data), /PRIVATE|note|actor_id|charge_paisa|commission|delivery_phone/);
    });

    await t.test('owner isolation, missing IDs, invalid encodings, SQL-looking IDs and roles are enforced over HTTP', async () => {
      for (const suffix of ['', '/tracking']) {
        assert.equal((await request(orderPath + suffix, { token: null })).status, 401);
        assert.equal((await request(orderPath + suffix, { token: 'f'.repeat(64) })).status, 401);
        for (const token of [seller.token, admin.token]) assert.equal((await request(orderPath + suffix, { token })).status, 403);
        const foreign = await request(orderPath + suffix, { token: other.token });
        const missing = await request('/customer/orders/missing' + suffix);
        assert.equal(foreign.status, 404);
        assert.deepEqual(foreign.body, missing.body);
        assert.equal(missing.status, 404);
        assert.equal((await request('/customer/orders/' + encodeURIComponent("' OR 1=1 --") + suffix)).status, 404);
        assert.equal((await request('/customer/orders/%ZZ' + suffix)).status, 400);
      }
    });

    await t.test('POST, PUT and DELETE seller products reach the correct handlers and preserve role/owner checks', async () => {
      const payload = { name_bn: 'নতুন চা', name_en: 'New tea', price_bdt: 50.25, stock: 2, category_slug: category.slug };
      assert.equal((await request('/seller/products', { method: 'POST', body: payload })).status, 403);
      const submitted = await request('/seller/products', { method: 'POST', token: seller.token, body: payload });
      assert.equal(submitted.status, 201);
      const productId = submitted.body.data.id;
      products.push(productId);
      const path = '/seller/products/' + productId;
      assert.equal(submitted.body.data.status, 'PENDING_REVIEW');
      for (const method of ['PUT', 'DELETE']) {
        const denied = await request(path, { method, token: secondSeller.token, body: { name_en: 'Not mine' } });
        assert.equal(denied.status, 404);
      }
      const edited = await request(path, { method: 'PUT', token: seller.token, body: { name_en: 'Edited tea' } });
      assert.equal(edited.status, 200);
      assert.equal((await request(path, { token: seller.token })).body.data.name_en, 'Edited tea');
      const invalid = await request(path, { method: 'PATCH', token: seller.token, body: {} });
      assert.equal(invalid.status, 405);
      assert.equal(invalid.headers.get('allow'), 'GET, PUT, DELETE');
      assert.equal((await request(path, { method: 'DELETE', token: seller.token })).status, 200);
      assert.equal((await request(path, { token: seller.token })).status, 404);
      assert.equal((await pool.query('SELECT status FROM products WHERE id=$1', [productId])).rows[0].status, 'ARCHIVED');
      const audits = (await pool.query('SELECT action FROM audit_logs WHERE entity_id=$1 ORDER BY created_at,id', [productId])).rows;
      assert.equal(audits.length, 3);
    });

    await t.test('customer cancellation updates tracking and restores each sellers stock only once', async () => {
      const cancelled = await request(orderPath + '/cancel', { method: 'POST', body: { reason: 'Changed plans' } });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.data.status, 'CANCELLED');
      assert.equal((await request(orderPath)).body.data.status, 'CANCELLED');
      const tracking = (await request(orderPath + '/tracking')).body.data;
      assert.ok(tracking.events.some(event => event.status === 'CANCELLED'));
      // A repeat must not reserve/restore inventory a second time.
      await request(orderPath + '/cancel', { method: 'POST', body: {} });
      const stocks = (await pool.query('SELECT stock FROM products WHERE id=ANY($1::text[])', [products.slice(0, 2)])).rows;
      assert.deepEqual(stocks.map(row => Number(row.stock)), [10, 10]);
    });

    await t.test('revoked and suspended customer sessions cannot read the order', async () => {
      await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [buyer.id]);
      assert.equal((await request(orderPath)).status, 401);
      await pool.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [buyer.id]);
      assert.equal((await request('/auth/logout', { method: 'POST' })).status, 200);
      assert.equal((await request(orderPath)).status, 401);
    });
  } finally {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await pool.query('DELETE FROM audit_logs WHERE actor_id=ANY($1::text[])', [users]);
      await pool.query('DELETE FROM transactions WHERE order_id=ANY($1::text[])', [orderIds]);
      await pool.query('DELETE FROM orders WHERE id=ANY($1::text[])', [orderIds]);
      await pool.query('DELETE FROM products WHERE id=ANY($1::text[])', [products]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
    } finally { await closePostgresPool(pool); }
  }
});
