import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { createPostgresPool, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { createPostgresCatalogRepository } from '../apps/api/src/postgres-catalog.mjs';
import { createPostgresCustomerRepository } from '../apps/api/src/postgres-customer.mjs';
import { createPostgresCheckoutRepository } from '../apps/api/src/postgres-checkout.mjs';
import { createPostgresCartRepository } from '../apps/api/src/postgres-cart.mjs';
import { createPostgresApiServer } from '../apps/api/src/postgres-server.mjs';
import { hashPassword } from '../apps/api/src/postgres-shared.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
test('real PostgreSQL customer account HTTP lifecycle: addresses, wishlist and verified reviews', {
  skip: !databaseUrl && 'POSTGRES_TEST_DATABASE_URL is not configured; disposable database required', timeout: 30000
}, async t => {
  const pool = await createPostgresPool({ env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl } });
  const users = [], products = [];
  let server, categoryId;
  try {
    await runPostgresMigrations(pool, new URL('../apps/api/migrations/postgres/', import.meta.url).pathname);
    const database = createPostgresDatabase(pool), auth = createPostgresAuthRepository(database);
    const timestamp = new Date().toISOString(), password = hashPassword('Disposable-customer-account-123');
    async function makeUser(role) {
      const user = { id: randomUUID(), phone: '018' + randomInt(10000000, 99999999), role };
      await pool.query('INSERT INTO users(id,phone,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)', [user.id, user.phone, 'Account fixture ' + role, password, role, timestamp]);
      users.push(user.id);
      return { ...user, token: await auth.createSession(user.id) };
    }
    const customer = await makeUser('CUSTOMER'), other = await makeUser('CUSTOMER');
    const seller = await makeUser('SELLER'), pendingSeller = await makeUser('SELLER'), admin = await makeUser('ADMIN');
    await pool.query(`INSERT INTO seller_profiles(user_id,shop_name,shop_address,status,commission_bps,created_at) VALUES($1,$2,'Fixture address','APPROVED',0,$3)`, [seller.id, 'Account shop ' + seller.id, timestamp]);
    await pool.query(`INSERT INTO seller_profiles(user_id,shop_name,shop_address,status,commission_bps,created_at) VALUES($1,$2,'Fixture address','PENDING',0,$3)`, [pendingSeller.id, 'Pending shop ' + pendingSeller.id, timestamp]);
    categoryId = randomUUID();
    await pool.query("INSERT INTO categories(id,slug,name_bn,name_en) VALUES($1,$2,'চা','Tea')", [categoryId, 'account-' + categoryId.slice(0, 8)]);
    async function makeProduct({ owner = seller.id, active = 1, stock = 5, nameEn = 'Tea' } = {}) {
      const productId = randomUUID();
      await pool.query(`INSERT INTO products(id,category_id,name_bn,name_en,price_paisa,stock,seller_id,active,status,created_at,updated_at)
        VALUES($1,$2,'চা',$3,1001,$4,$5,$6,'ACTIVE',$7,$7)`, [productId, categoryId, nameEn, stock, owner, active, timestamp]);
      products.push(productId);
      return productId;
    }
    const visible = await makeProduct();
    const hidden = await makeProduct({ active: 0, nameEn: 'Hidden' });
    const unapproved = await makeProduct({ owner: pendingSeller.id, nameEn: 'Unapproved' });

    server = createPostgresApiServer({
      database, authRepository: auth,
      catalogRepository: createPostgresCatalogRepository(database),
      customerRepository: createPostgresCustomerRepository(database), env: process.env
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
    async function request(path, { method = 'GET', token = customer.token, body } = {}) {
      const sendsBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
      const response = await fetch(base + path, {
        method,
        headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(sendsBody ? { 'content-type': 'application/json' } : {}) },
        ...(sendsBody ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
      });
      return { status: response.status, body: await response.json() };
    }
    const address = (overrides = {}) => ({ label: 'বাসা', name: 'ক্রেতা', phone: '01711111111', address: 'রোড ১, বাড়ি ২', area: 'ঢাকা', ...overrides });
    const rows = async (table, column, value) => (await pool.query(`SELECT * FROM ${table} WHERE ${column}=$1`, [value])).rows;

    await t.test('all customer account routes require an active CUSTOMER session', async () => {
      for (const [method, path] of [
        ['GET', '/customer/addresses'], ['POST', '/customer/addresses'], ['PUT', '/customer/addresses/x'],
        ['DELETE', '/customer/addresses/x'], ['GET', '/customer/wishlist'], ['POST', '/customer/wishlist'],
        ['DELETE', '/customer/wishlist/x'], ['POST', '/customer/products/' + visible + '/reviews']
      ]) {
        assert.equal((await request(path, { method, token: null, body: {} })).status, 401);
        for (const token of [seller.token, admin.token]) assert.equal((await request(path, { method, token, body: {} })).status, 403);
      }
      await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [customer.id]);
      assert.equal((await request('/customer/addresses')).status, 401, 'suspended sessions must not read addresses');
      await pool.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [customer.id]);
      assert.equal((await request('/customer/addresses')).status, 200);
    });

    await t.test('first saved address becomes the default and address fields are normalized', async () => {
      assert.deepEqual((await request('/customer/addresses')).body, { data: [] });
      const created = await request('/customer/addresses', { method: 'POST', body: address({ phone: ' 01711-111111 ' }) });
      assert.equal(created.status, 201);
      assert.ok(created.body.data.id);
      const list = (await request('/customer/addresses')).body.data;
      assert.equal(list.length, 1);
      assert.equal(list[0].is_default, 1);
      assert.equal(list[0].phone, '01711111111');
      assert.equal(list[0].label, 'বাসা');
    });

    await t.test('invalid address payloads are rejected without inserting rows', async () => {
      for (const body of [{}, { phone: '123', address: 'x', area: 'y' }, { ...address(), address: '' }, { ...address(), area: '' }, { ...address(), name: 'x'.repeat(101) }, { ...address(), is_default: 'yes' }, { ...address(), label: 'x'.repeat(41) }]) {
        assert.equal((await request('/customer/addresses', { method: 'POST', body })).status, 400, JSON.stringify(body).slice(0, 60));
      }
      assert.equal((await rows('addresses', 'user_id', customer.id)).length, 1);
      assert.equal((await request('/customer/addresses', { method: 'POST', body: 'not json' })).status, 400);
    });

    await t.test('updating the default address promotes exactly one default and other customers stay isolated', async () => {
      const second = await request('/customer/addresses', { method: 'POST', body: address({ label: 'অফিস', area: 'চট্টগ্রাম' }) });
      assert.equal(second.status, 201);
      let list = (await request('/customer/addresses')).body.data;
      assert.equal(list.length, 2);
      assert.equal(list.filter(item => item.is_default === 1).length, 1);
      assert.equal((await request('/customer/addresses/' + second.body.data.id, { method: 'PUT', body: address({ label: 'অফিস', area: 'চট্টগ্রাম', is_default: true }) })).status, 200);
      list = (await request('/customer/addresses')).body.data;
      assert.equal(list.filter(item => item.is_default === 1).length, 1);
      assert.equal(list[0].id, second.body.data.id, 'default address sorts first');
      assert.equal((await request('/customer/addresses/' + second.body.data.id, { method: 'PUT', token: other.token, body: address() })).status, 404);
      await request('/customer/addresses/' + second.body.data.id, { method: 'PUT', token: other.token, body: address() });
      assert.equal((await rows('addresses', 'user_id', customer.id)).find(item => item.id === second.body.data.id).label, 'অফিস');
      assert.equal((await request('/customer/addresses/' + randomUUID(), { method: 'PUT', body: address() })).status, 404);
      assert.equal((await request('/customer/addresses/' + second.body.data.id, { method: 'DELETE', token: other.token })).status, 200);
      assert.equal((await rows('addresses', 'user_id', customer.id)).length, 2, 'foreign delete is a no-op, not a removal');
    });

    await t.test('deleting the default address promotes a remaining address', async () => {
      const list = (await request('/customer/addresses')).body.data;
      const current = list.find(item => item.is_default === 1);
      assert.equal((await request('/customer/addresses/' + current.id, { method: 'DELETE' })).status, 200);
      const remaining = (await request('/customer/addresses')).body.data;
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].is_default, 1);
      await request('/customer/addresses/' + remaining[0].id, { method: 'DELETE' });
      assert.deepEqual((await request('/customer/addresses')).body.data, []);
    });

    await t.test('concurrent address creation stops at ten and never leaves two defaults', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, (_unused, index) => request('/customer/addresses', {
        method: 'POST', body: address({ label: 'সংখ্যা ' + index, is_default: false })
      })));
      const created = results.filter(result => result.status === 201);
      assert.equal(created.length, 10, 'exactly the ten-address cap is persisted');
      assert.ok(results.filter(result => result.status === 400).length === 2);
      const saved = (await request('/customer/addresses')).body.data;
      assert.equal(saved.length, 10);
      assert.equal(saved.filter(item => item.is_default === 1).length, 1);
      assert.equal((await request('/customer/addresses', { method: 'POST', body: address() })).status, 400);
      for (const item of saved) await request('/customer/addresses/' + item.id, { method: 'DELETE' });
    });

    await t.test('wishlist adds only visible approved-seller products, is idempotent and scoped per customer', async () => {
      assert.deepEqual((await request('/customer/wishlist')).body.data, []);
      for (const productId of [hidden, unapproved]) {
        assert.equal((await request('/customer/wishlist', { method: 'POST', body: { productId } })).status, 404);
      }
      for (const productId of [undefined, null, '', '   ', 42, true, ['p'], { id: 'p' }, 'x'.repeat(101)]) {
        assert.equal((await request('/customer/wishlist', { method: 'POST', body: { productId } })).status, 400, String(productId).slice(0, 12));
      }
      const added = await request('/customer/wishlist', { method: 'POST', body: { productId: visible } });
      assert.equal(added.status, 201);
      assert.deepEqual(added.body, { data: { added: true } });
      assert.equal((await request('/customer/wishlist', { method: 'POST', body: { productId: visible } })).status, 201);
      assert.equal((await pool.query('SELECT COUNT(*) n FROM wishlists WHERE user_id=$1', [customer.id])).rows[0].n, '1');
      const list = (await request('/customer/wishlist')).body.data;
      assert.equal(list.length, 1);
      assert.equal(list[0].id, visible);
      assert.equal(list[0].price_bdt, 10.01);
      assert.equal(list[0].in_stock, true);
      assert.deepEqual((await request('/customer/wishlist', { token: other.token })).body.data, []);
      assert.equal((await request(`/customer/wishlist/${visible}`, { method: 'DELETE', token: other.token })).status, 200);
      assert.equal((await request('/customer/wishlist')).body.data.length, 1, 'other customers cannot clear this wishlist');
      assert.equal((await request(`/customer/wishlist/${visible}`, { method: 'DELETE' })).status, 200);
      assert.deepEqual((await request('/customer/wishlist')).body.data, []);
      assert.equal((await request('/customer/wishlist/%', { method: 'DELETE' })).status, 400, 'bad percent-encoding is a 400, not a crash');
    });

    await t.test('reviews require a delivered purchase, are unique per customer/product and appear publicly', async () => {
      const reviewPath = '/customer/products/' + visible + '/reviews';
      assert.equal((await request(reviewPath, { method: 'POST', body: { rating: 5, comment: 'خیلی خوب' } })).status, 403, 'no delivered order yet');
      for (const rating of [0, 6, 4.5, 'five', true, null, [5], { rating: 5 }]) {
        assert.equal((await request(reviewPath, { method: 'POST', body: { rating } })).status, 400, 'rating ' + JSON.stringify(rating));
      }
      assert.equal((await request(reviewPath, { method: 'POST', body: { rating: 5, comment: 'x'.repeat(1001) } })).status, 400);
      assert.equal((await rows('reviews', 'product_id', visible)).length, 0);

      const checkout = createPostgresCheckoutRepository(database, { shippingFor: async () => 0 }); // Test-only shipping policy.
      const cart = createPostgresCartRepository(database);
      await cart.setItemQuantity(customer.id, visible, 1);
      const delivery = { name: 'ক্রেতা', phone: customer.phone, address: 'রোড ১', area: 'ঢাকা' };
      const placed = await checkout.checkout(customer, { delivery });
      assert.equal((await request(reviewPath, { method: 'POST', body: { rating: 5, comment: 'ভালো পণ্য' } })).status, 403, 'confirmed but not delivered orders cannot review');
      await pool.query("UPDATE seller_orders SET status='DELIVERED' WHERE order_id=$1", [placed.id]);
      const created = await request(reviewPath, { method: 'POST', body: { rating: ' 5 ', comment: '  ভালো পণ্য  ' } });
      assert.equal(created.status, 201);
      assert.deepEqual(created.body, { data: { saved: true } });
      const [review] = await rows('reviews', 'product_id', visible);
      assert.equal(Number(review.rating), 5);
      assert.equal(review.comment, 'ভালো পণ্য');
      assert.equal(review.user_id, customer.id);
      const publicReviews = await request('/products/' + visible + '/reviews', { token: null });
      assert.equal(publicReviews.status, 200);
      assert.equal(publicReviews.body.data.length, 1);
      assert.equal(publicReviews.body.data[0].rating, 5);
      assert.equal(publicReviews.body.data[0].name, customer.name || 'Account fixture CUSTOMER');
      const product = await request('/products/' + visible, { token: null });
      assert.equal(product.body.data.review_count, 1);
      assert.equal(product.body.data.rating, 5);
      assert.equal((await request(reviewPath, { method: 'POST', body: { rating: 2, comment: 'পরিবর্তিত' } })).status, 201);
      assert.equal((await rows('reviews', 'product_id', visible)).length, 1, 'repeat review updates instead of duplicating');
      assert.equal(Number((await rows('reviews', 'product_id', visible))[0].rating), 2);
      assert.equal((await request('/customer/products/' + randomUUID() + '/reviews', { method: 'POST', body: { rating: 5 } })).status, 403);
      assert.equal((await request('/customer/products/%25/reviews', { method: 'POST', body: { rating: 5 } })).status, 403, 'unknown escaped id is simply not a delivered purchase');
    });
  } finally {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await pool.query('DELETE FROM orders WHERE user_id=ANY($1::text[])', [users]);
      await pool.query('DELETE FROM products WHERE id=ANY($1::text[])', [products]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
      await pool.query('DELETE FROM categories WHERE id=$1', [categoryId]);
    } finally { await closePostgresPool(pool); }
  }
});
