import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresApi, createPostgresApiServer } from '../apps/api/src/postgres-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'apps/api/src/postgres-server.mjs');

async function importGraph(file, seen = new Set()) {
  const absolute = resolve(file);
  if (seen.has(absolute)) return seen;
  seen.add(absolute);
  const source = await readFile(absolute, 'utf8');
  const imports = [...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
  for (const specifier of imports) if (specifier.startsWith('.')) await importGraph(resolve(dirname(absolute), specifier), seen);
  return seen;
}
function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql) { calls.push(sql); return { rows: [{ database: 'marketplace_test', version: 'PostgreSQL 17' }], rowCount: 1 }; },
    async connect() { throw new Error('unexpected connect'); },
    async end() { this.closed = true; }
  };
}
function fakeCatalog() {
  return {
    async listCategories() { return [{ slug: 'tea' }]; },
    async listBrands() { return [{ slug: 'brand' }]; },
    async listProducts(params) { return [{ query: params.get('q') }]; },
    async suggestProducts() { return [{ id: 'p1' }]; },
    async getProduct(id) { return id === 'missing' ? null : { id }; },
    async listReviews(id) { return [{ product_id: id }]; }
  };
}
const validToken = 'a'.repeat(40);
const validSellerToken = 'b'.repeat(40);
const validAdminToken = 'c'.repeat(40);
function fakeAuth() {
  const calls = [];
  const user = { id: 'u1', name: 'Test User', role: 'CUSTOMER', token_hash: 'hash' };
  return {
    calls,
    async getSessionUser(token) { calls.push(['getSessionUser', token]); return token === validToken ? user : token === validSellerToken ? { ...user, id: 's1', role: 'SELLER' } : token === validAdminToken ? { ...user, id: 'admin-1', role: 'ADMIN' } : null; },
    async registerCustomer(body) { calls.push(['registerCustomer', body]); return { token: validToken, data: { id: 'u1', role: 'CUSTOMER' } }; },
    async registerSeller(body) { calls.push(['registerSeller', body]); return { token: validToken, data: { id: 's1', role: 'SELLER', status: 'PENDING' } }; },
    async login(body) { calls.push(['login', body]); return { token: validToken, data: { id: 'u1', role: 'CUSTOMER' } }; },
    async logout(value) { calls.push(['logout', value.id]); return { loggedOut: true }; },
    async getMe(value) { calls.push(['getMe', value.id]); return { id: value.id, role: value.role }; },
    async updateProfile(value, body) { calls.push(['updateProfile', value.id, body]); return { id: value.id, name: body.name }; },
    async changePassword(value, body) { calls.push(['changePassword', value.id, body]); return { changed: true }; },
    async forgotPassword(body) { calls.push(['forgotPassword', body]); return { message: 'If account exists' }; },
    async resetPassword(body) { calls.push(['resetPassword', body]); return { reset: true }; },
    async sendVerification(value, body) { calls.push(['sendVerification', value.id, body]); return { sent: true }; },
    async verify(value, body) { calls.push(['verify', value.id, body]); return { verified: 'PHONE' }; },
    async listNotifications(id) { calls.push(['listNotifications', id]); return [{ id: 'n1' }]; },
    async markNotificationsRead(id) { calls.push(['markNotificationsRead', id]); return { read: true }; }
  };
}
function fakeCustomer() {
  const calls = [];
  return {
    calls,
    async listAddresses(userId) { calls.push(['listAddresses', userId]); return [{ id: 'a1' }]; },
    async createAddress(input) { calls.push(['createAddress', input.user.id, input.body]); return { id: 'a2' }; },
    async updateAddress(input) { calls.push(['updateAddress', input.user.id, input.addressId]); return { id: input.addressId }; },
    async deleteAddress(userId, addressId) { calls.push(['deleteAddress', userId, addressId]); return { deleted: true }; },
    async listWishlist(userId) { calls.push(['listWishlist', userId]); return [{ id: 'p1' }]; },
    async addWishlist(userId, productId) { calls.push(['addWishlist', userId, productId]); return { added: true }; },
    async removeWishlist(userId, productId) { calls.push(['removeWishlist', userId, productId]); return { removed: true }; },
    async saveReview(input) { calls.push(['saveReview', input.userId, input.productId]); return { saved: true }; }
  };
}
async function withServer({ authRepository = fakeAuth(), customerRepository = fakeCustomer(), database: suppliedDatabase, env = {} } = {}, run) {
  const database = suppliedDatabase || { q(sql) { return { async get() { if (sql === 'SELECT 1 AS ok') return { ok: 1 }; return undefined; }, async all() { return []; }, async run() { return { changes: 1, rows: [] }; } }; }, async tx(fn) { return fn(); } };
  const server = createPostgresApiServer({ database, catalogRepository: fakeCatalog(), authRepository, customerRepository, env });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await run(base, authRepository); }
  finally { await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); }
}
const env = overrides => ({
  DATABASE_URL: 'postgresql://marketplace:secret@localhost:5432/marketplace_test',
  PG_AUTO_MIGRATE: '1',
  ...overrides
});

test('PostgreSQL HTTP import graph is SQLite-free', async () => {
  const files = await importGraph(entry);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /node:sqlite|DatabaseSync|core\.mjs|seed\.mjs|routes_(?:public|customer|seller|admin|payments|postgres_domain)\.mjs/);
  }
  assert.ok([...files].some(file => file.endsWith('/postgres-catalog.mjs')));
  assert.ok([...files].some(file => file.endsWith('/postgres-auth.mjs')));
  assert.ok([...files].some(file => file.endsWith('/postgres-customer.mjs')));
  assert.ok([...files].some(file => file.endsWith('/postgres-runtime.mjs')));
});

test('PostgreSQL server serves health and catalog routes without exposing order routes', async () => {
  await withServer({}, async base => {
    const get = async path => {
      const response = await fetch(base + path);
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual(await get('/health'), { status: 200, body: { ok: true, service: 'marketplace-api', db: 'ok', runtime: 'postgresql' } });
    assert.deepEqual(await get('/api/v1/categories'), { status: 200, body: { data: [{ slug: 'tea' }] } });
    assert.deepEqual(await get('/api/v1/products?q=tea'), { status: 200, body: { data: [{ query: 'tea' }] } });
    assert.deepEqual(await get('/api/v1/products/p1/reviews'), { status: 200, body: { data: [{ product_id: 'p1' }] } });
    assert.deepEqual(await get('/api/v1/products/missing'), { status: 404, body: { error: 'Product not found' } });
    assert.deepEqual(await get('/api/v1/orders'), { status: 404, body: { error: 'Not found' } });
    const method = await fetch(base + '/api/v1/products', { method: 'POST' });
    assert.equal(method.status, 405);
  });
});

test('PostgreSQL auth routes preserve public response contracts and require a valid bearer session', async () => {
  await withServer({}, async (base, auth) => {
    const post = (path, body, headers = {}) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
    });
    const registered = await post('/api/v1/auth/register', { name: 'Test', phone: '01711111111' });
    assert.equal(registered.status, 201);
    assert.equal((await registered.json()).data.role, 'CUSTOMER');
    const login = await post('/api/v1/auth/login', { identifier: '01711111111', password: 'Password@123' });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).token, validToken);

    const unauthenticated = await fetch(base + '/api/v1/auth/me');
    assert.equal(unauthenticated.status, 401);
    const me = await fetch(base + '/api/v1/auth/me', { headers: { authorization: 'Bearer ' + validToken } });
    assert.deepEqual(await me.json(), { data: { id: 'u1', role: 'CUSTOMER' } });
    const updated = await fetch(base + '/api/v1/me', {
      method: 'PATCH', headers: { authorization: 'Bearer ' + validToken, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name' })
    });
    assert.deepEqual(await updated.json(), { data: { id: 'u1', name: 'Updated Name' } });
    const logout = await post('/api/v1/auth/logout', {}, { authorization: 'Bearer ' + validToken });
    assert.deepEqual(await logout.json(), { data: { loggedOut: true } });
    const notifications = await fetch(base + '/api/v1/notifications', { headers: { authorization: 'Bearer ' + validToken } });
    assert.deepEqual(await notifications.json(), { data: [{ id: 'n1' }] });
    assert.ok(auth.calls.some(call => call[0] === 'updateProfile'));
  });
});

test('auth request parser rejects malformed JSON, wrong content type, and oversized bodies', async () => {
  await withServer({}, async base => {
    const malformed = await fetch(base + '/api/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken'
    });
    assert.equal(malformed.status, 400);
    const wrongType = await fetch(base + '/api/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello'
    });
    assert.equal(wrongType.status, 415);
    const oversized = await fetch(base + '/api/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(70 * 1024) })
    });
    assert.equal(oversized.status, 413);
  });
});

test('public authentication endpoints apply per-IP rate limits', async () => {
  await withServer({}, async base => {
    let last;
    for (let i = 0; i < 13; i++) {
      last = await fetch(base + '/api/v1/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: '01711111111', password: 'wrong' })
      });
      if (i < 12) assert.equal(last.status, 200);
    }
    assert.equal(last.status, 429);
    assert.equal(last.headers.get('retry-after'), '60');
  });
});


test('PostgreSQL customer routes enforce CUSTOMER role and delegate addresses, wishlist and reviews', async () => {
  const customerRepository = fakeCustomer();
  await withServer({ customerRepository }, async base => {
    const auth = { authorization: 'Bearer ' + validToken };
    const get = path => fetch(base + path, { headers: auth });
    const addresses = await get('/api/v1/customer/addresses');
    assert.deepEqual(await addresses.json(), { data: [{ id: 'a1' }] });
    const created = await fetch(base + '/api/v1/customer/addresses', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Home', phone: '01711111111', address: 'Dhaka', area: 'Dhaka' })
    });
    assert.equal(created.status, 201);
    const updated = await fetch(base + '/api/v1/customer/addresses/a2', {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ phone: '01711111111' })
    });
    assert.equal(updated.status, 200);
    const wishlist = await get('/api/v1/customer/wishlist');
    assert.deepEqual(await wishlist.json(), { data: [{ id: 'p1' }] });
    const added = await fetch(base + '/api/v1/customer/wishlist', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ productId: 'p1' })
    });
    assert.equal(added.status, 201);
    const review = await fetch(base + '/api/v1/customer/products/p1/reviews', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ rating: 5 })
    });
    assert.equal(review.status, 201);
    assert.ok(customerRepository.calls.some(call => call[0] === 'saveReview'));
  });
});

test('seller sessions cannot access customer-only routes', async () => {
  await withServer({}, async base => {
    const response = await fetch(base + '/api/v1/customer/addresses', {
      headers: { authorization: 'Bearer ' + validSellerToken }
    });
    assert.equal(response.status, 403);
  });
});

test('production startup remains blocked while marketplace domains are incomplete', async () => {
  let called = false;
  await assert.rejects(createPostgresApi({ env: env({ NODE_ENV: 'production' }), createPool: async () => { called = true; return fakePool(); } }), /PostgreSQL API is incomplete/);
  assert.equal(called, false);
});

test('startup fails closed before loading pg when DATABASE_URL is missing or invalid', async () => {
  let called = false;
  await assert.rejects(createPostgresApi({ env: {}, createPool: async () => { called = true; return fakePool(); } }), /DATABASE_URL is required/);
  await assert.rejects(createPostgresApi({ env: env({ DATABASE_URL: 'https://not-postgres.test' }), createPool: async () => { called = true; return fakePool(); } }), /postgres:\/\//);
  assert.equal(called, false);
});

test('startup verifies PostgreSQL and applies migrations before creating the HTTP server', async () => {
  const pool = fakePool(), order = [];
  const app = await createPostgresApi({
    env: env({}),
    createPool: async options => { order.push(['pool', options.env.DATABASE_URL]); return pool; },
    verifyConnection: async value => { assert.equal(value, pool); order.push('verify'); return { database: 'marketplace_test', version: 'PostgreSQL 17' }; },
    migrate: async (value, directory) => { assert.equal(value, pool); assert.match(directory, /migrations[\\/]postgres$/); order.push('migrate'); return { applied: ['001_init.sql'], current: ['001_init.sql'] }; },
    createServer: options => { order.push(['server', Boolean(options.authRepository)]); return { options }; }
  });
  assert.deepEqual(order.map(item => Array.isArray(item) ? item[0] : item), ['pool', 'verify', 'migrate', 'server']);
  assert.equal(order[3][1], true);
  assert.equal(app.connection.version, 'PostgreSQL 17');
  assert.deepEqual(app.migrationResult.applied, ['001_init.sql']);
});

test('startup can skip migrations only when explicitly configured', async () => {
  const pool = fakePool();
  let migrations = 0;
  await createPostgresApi({
    env: env({ PG_AUTO_MIGRATE: '0' }),
    createPool: async () => pool,
    verifyConnection: async () => ({ database: 'marketplace_test', version: 'PostgreSQL 17' }),
    migrate: async () => { migrations++; },
    createServer: () => ({})
  });
  assert.equal(migrations, 0);
});

test('startup closes the pool if connection verification or migration fails', async () => {
  const pool = fakePool();
  await assert.rejects(createPostgresApi({
    env: env({}), createPool: async () => pool,
    verifyConnection: async () => { throw new Error('database unavailable'); }, migrate: async () => null
  }), /database unavailable/);
  assert.equal(pool.closed, true);
  const second = fakePool();
  await assert.rejects(createPostgresApi({
    env: env({}), createPool: async () => second,
    verifyConnection: async () => ({ database: 'marketplace_test', version: 'PostgreSQL 17' }),
    migrate: async () => { throw new Error('migration failure'); }
  }), /migration failure/);
  assert.equal(second.closed, true);
});


test('PostgreSQL commerce routes are mounted with customer, seller and admin role isolation', async () => {
  await withServer({}, async base => {
    const customer = { authorization: 'Bearer ' + validToken };
    const seller = { authorization: 'Bearer ' + validSellerToken };
    const customerOrders = await fetch(base + '/api/v1/customer/orders', { headers: customer });
    assert.equal(customerOrders.status, 200);
    assert.deepEqual(await customerOrders.json(), { data: [] });
    const sellerCannotReadCustomerOrders = await fetch(base + '/api/v1/customer/orders', { headers: seller });
    assert.equal(sellerCannotReadCustomerOrders.status, 403);
    const sellerOrders = await fetch(base + '/api/v1/seller/orders', { headers: seller });
    assert.equal(sellerOrders.status, 200);
    assert.deepEqual(await sellerOrders.json(), { data: [] });
    const customerCannotReadAdminOrders = await fetch(base + '/api/v1/admin/orders', { headers: customer });
    assert.equal(customerCannotReadAdminOrders.status, 403);
    const unauthenticated = await fetch(base + '/api/v1/customer/orders');
    assert.equal(unauthenticated.status, 401);
  });
});


test('admin seller lifecycle routes enforce ADMIN role at the HTTP boundary and persist decisions', async () => {
  const calls = [];
  const database = {
    q(sql) {
      return {
        async get(...args) {
          calls.push(['get', sql, args]);
          if (sql.includes('FROM seller_profiles sp JOIN users u')) return {
            user_id: 'seller-1', shop_name: 'Dhaka Store', status: 'PENDING', account_status: 'ACTIVE'
          };
          return undefined;
        },
        async all(...args) {
          calls.push(['all', sql, args]);
          return [{ user_id: 'seller-1', status: 'PENDING' }];
        },
        async run(...args) {
          calls.push(['run', sql, args]);
          return { changes: 1, rows: [] };
        }
      };
    },
    async tx(fn) { calls.push(['tx-start']); try { return await fn(); } finally { calls.push(['tx-end']); } }
  };
  await withServer({ database }, async base => {
    const queueUnauth = await fetch(base + '/api/v1/admin/sellers');
    assert.equal(queueUnauth.status, 401);
    const sellerDenied = await fetch(base + '/api/v1/admin/sellers', {
      headers: { authorization: 'Bearer ' + validSellerToken }
    });
    assert.equal(sellerDenied.status, 403);
    const adminHeaders = { authorization: 'Bearer ' + validAdminToken };
    const queue = await fetch(base + '/api/v1/admin/sellers?status=PENDING', { headers: adminHeaders });
    assert.equal(queue.status, 200);
    assert.equal((await queue.json()).data[0].user_id, 'seller-1');
    const approved = await fetch(base + '/api/v1/admin/sellers/seller-1/status', {
      method: 'PATCH', headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'APPROVED', note: 'KYC checked' })
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).data.status, 'APPROVED');
    assert.ok(calls.some(call => call[1]?.includes('INSERT INTO audit_logs')));
    assert.ok(calls.some(call => call[1]?.includes('INSERT INTO notifications')));
  });
});


test('PostgreSQL CORS preflight only grants explicitly configured browser origins', async () => {
  await withServer({ env: env({ CORS_ORIGINS: 'https://shop.example.com,https://admin.example.com' }) }, async base => {
    const allowed = await fetch(base + '/api/v1/products', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://shop.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://shop.example.com');
    assert.equal(allowed.headers.get('vary'), 'Origin');

    const rejected = await fetch(base + '/api/v1/products', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'GET'
      }
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);

    const nonBrowser = await fetch(base + '/api/v1/categories');
    assert.equal(nonBrowser.status, 200);
    assert.equal(nonBrowser.headers.get('access-control-allow-origin'), null);
  });
});

test('PostgreSQL CORS does not reflect an untrusted origin on ordinary API responses', async () => {
  await withServer({ env: env({ CORS_ORIGINS: 'https://shop.example.com' }) }, async base => {
    const trusted = await fetch(base + '/api/v1/categories', {
      headers: { origin: 'https://shop.example.com' }
    });
    assert.equal(trusted.status, 200);
    assert.equal(trusted.headers.get('access-control-allow-origin'), 'https://shop.example.com');

    const untrusted = await fetch(base + '/api/v1/categories', {
      headers: { origin: 'https://attacker.example' }
    });
    assert.equal(untrusted.status, 200);
    assert.equal(untrusted.headers.get('access-control-allow-origin'), null);
  });
});


test('PostgreSQL CORS treats wildcard and lookalike origins as untrusted', async () => {
  await withServer({ env: env({ CORS_ORIGINS: '*,https://shop.example.com ' }) }, async base => {
    const wildcard = await fetch(base + '/api/v1/categories', {
      headers: { origin: 'https://random.example' }
    });
    assert.equal(wildcard.status, 200);
    assert.equal(wildcard.headers.get('access-control-allow-origin'), null);

    const lookalike = await fetch(base + '/api/v1/categories', {
      headers: { origin: 'https://shop.example.com.attacker.test' }
    });
    assert.equal(lookalike.status, 200);
    assert.equal(lookalike.headers.get('access-control-allow-origin'), null);

    const exact = await fetch(base + '/api/v1/categories', {
      headers: { origin: 'https://shop.example.com' }
    });
    assert.equal(exact.status, 200);
    assert.equal(exact.headers.get('access-control-allow-origin'), 'https://shop.example.com');
  });
});

test('domain dispatch resolves the method before enforcing authentication on shared product paths', async () => {
  await withServer({}, async base => {
    for (const [method, path] of [
      ['GET', '/api/v1/seller/products'], ['POST', '/api/v1/seller/products'],
      ['GET', '/api/v1/seller/products/p1'], ['PUT', '/api/v1/seller/products/p1'],
      ['DELETE', '/api/v1/seller/products/p1']
    ]) {
      const unauthenticated = await fetch(base + path, { method });
      assert.equal(unauthenticated.status, 401, method + ' must reach its registered auth boundary, not 405');
      const wrongRole = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + validToken } });
      assert.equal(wrongRole.status, 403, method + ' must enforce SELLER role');
    }
  });
});

test('unsupported domain methods advertise all allowed methods without confusing unknown paths', async () => {
  await withServer({}, async base => {
    for (const [path, allow] of [
      ['/api/v1/seller/products', 'GET, POST'], ['/api/v1/seller/products/p1', 'GET, PUT, DELETE']
    ]) {
      const response = await fetch(base + path, { method: 'PATCH' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), allow);
    }
    const missing = await fetch(base + '/api/v1/not-a-route', { method: 'PATCH' });
    assert.equal(missing.status, 404);
  });
});

test('customer detail and tracking HTTP routes enforce authentication, roles and opaque 404s', async () => {
  await withServer({}, async base => {
    for (const suffix of ['', '/tracking']) {
      const path = '/api/v1/customer/orders/unknown' + suffix;
      assert.equal((await fetch(base + path)).status, 401);
      for (const token of [validSellerToken, validAdminToken]) {
        assert.equal((await fetch(base + path, { headers: { authorization: 'Bearer ' + token } })).status, 403);
      }
      const owned = await fetch(base + path, { headers: { authorization: 'Bearer ' + validToken } });
      assert.equal(owned.status, 404);
      assert.deepEqual(await owned.json(), { error: 'Order not found' });
      const unsupported = await fetch(base + path, { method: 'PUT' });
      assert.equal(unsupported.status, 405);
      assert.equal(unsupported.headers.get('allow'), 'GET');
      const malformed = await fetch(base + '/api/v1/customer/orders/%ZZ' + suffix, { headers: { authorization: 'Bearer ' + validToken } });
      assert.equal(malformed.status, 400);
    }
  });
});
