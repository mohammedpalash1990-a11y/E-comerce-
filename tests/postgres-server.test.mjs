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
  for (const specifier of imports) {
    if (!specifier.startsWith('.')) continue;
    await importGraph(resolve(dirname(absolute), specifier), seen);
  }
  return seen;
}

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      return { rows: [{ database: 'marketplace_test', version: 'PostgreSQL 17' }], rowCount: 1 };
    },
    async connect() { throw new Error('unexpected connect'); },
    async end() { this.closed = true; }
  };
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
  assert.ok([...files].some(file => file.endsWith('/postgres-runtime.mjs')));
});

test('PostgreSQL server exposes only health and PostgreSQL-backed catalog routes', async () => {
  const database = { q(sql) { return { async get() { assert.equal(sql, 'SELECT 1 AS ok'); return { ok: 1 }; } }; } };
  const catalogRepository = {
    async listCategories() { return [{ slug: 'tea' }]; },
    async listBrands() { return [{ slug: 'brand' }]; },
    async listProducts(params) { return [{ query: params.get('q') }]; },
    async suggestProducts() { return [{ id: 'p1' }]; },
    async getProduct(id) { return id === 'missing' ? null : { id }; },
    async listReviews(id) { return [{ product_id: id }]; }
  };
  const server = createPostgresApiServer({ database, catalogRepository, env: {} });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  try {
    const get = async path => {
      const response = await fetch('http://127.0.0.1:' + port + path);
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual(await get('/health'), { status: 200, body: { ok: true, service: 'marketplace-api', db: 'ok', runtime: 'postgresql' } });
    assert.deepEqual(await get('/api/v1/categories'), { status: 200, body: { data: [{ slug: 'tea' }] } });
    assert.deepEqual(await get('/api/v1/products?q=tea'), { status: 200, body: { data: [{ query: 'tea' }] } });
    assert.deepEqual(await get('/api/v1/products/p1/reviews'), { status: 200, body: { data: [{ product_id: 'p1' }] } });
    assert.deepEqual(await get('/api/v1/products/missing'), { status: 404, body: { error: 'Product not found' } });
    assert.deepEqual(await get('/api/v1/orders'), { status: 404, body: { error: 'Not found' } });
    const method = await fetch('http://127.0.0.1:' + port + '/api/v1/products', { method: 'POST' });
    assert.equal(method.status, 405);
  } finally {
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
});

test('production startup remains blocked until all PostgreSQL domains are integrated', async () => {
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
  const pool = fakePool();
  const order = [];
  const app = await createPostgresApi({
    env: env({}),
    createPool: async options => { order.push(['pool', options.env.DATABASE_URL]); return pool; },
    verifyConnection: async value => { assert.equal(value, pool); order.push('verify'); return { database: 'marketplace_test', version: 'PostgreSQL 17' }; },
    migrate: async (value, directory) => { assert.equal(value, pool); assert.match(directory, /migrations[\\/]postgres$/); order.push('migrate'); return { applied: ['001_init.sql'], current: ['001_init.sql'] }; },
    createServer: options => { order.push('server'); return { options }; }
  });
  assert.deepEqual(order.map(item => Array.isArray(item) ? item[0] : item), ['pool', 'verify', 'migrate', 'server']);
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
    env: env({}),
    createPool: async () => pool,
    verifyConnection: async () => { throw new Error('database unavailable'); },
    migrate: async () => null
  }), /database unavailable/);
  assert.equal(pool.closed, true);
  const second = fakePool();
  await assert.rejects(createPostgresApi({
    env: env({}),
    createPool: async () => second,
    verifyConnection: async () => ({ database: 'marketplace_test', version: 'PostgreSQL 17' }),
    migrate: async () => { throw new Error('migration failure'); }
  }), /migration failure/);
  assert.equal(second.closed, true);
});
