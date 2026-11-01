import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresPool, postgresPoolOptions, verifyPostgresConnection, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';

const env = overrides => ({
  DATABASE_URL: 'postgresql://marketplace:secret@db.example.test:5432/marketplace',
  ...overrides
});

test('PostgreSQL pool defaults to verified TLS and bounded pool settings', () => {
  const options = postgresPoolOptions(env({}));
  assert.equal(options.max, 10);
  assert.equal(options.idleTimeoutMillis, 30000);
  assert.equal(options.connectionTimeoutMillis, 10000);
  assert.equal(options.keepAlive, true);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(options.application_name, 'bangladesh-marketplace-api');
  assert.equal(options.connectionString.includes('secret'), true);
});

test('PostgreSQL pool accepts explicit SSL disable only when configured', () => {
  assert.equal(postgresPoolOptions(env({ PGSSL_MODE: 'disable' })).ssl, false);
  assert.deepEqual(postgresPoolOptions(env({ PGSSL_REJECT_UNAUTHORIZED: 'false' })).ssl, { rejectUnauthorized: false });
  assert.throws(() => postgresPoolOptions(env({ PGSSL_MODE: 'prefer' })), /PGSSL_MODE/);
});

test('PostgreSQL pool rejects missing, malformed and non-PostgreSQL URLs', () => {
  assert.throws(() => postgresPoolOptions({}), /DATABASE_URL is required/);
  assert.throws(() => postgresPoolOptions(env({ DATABASE_URL: 'not a url' })), /valid PostgreSQL/);
  assert.throws(() => postgresPoolOptions(env({ DATABASE_URL: 'https://example.test' })), /postgres:\/\//);
});

test('PostgreSQL pool validates numeric limits before constructing the driver', () => {
  assert.throws(() => postgresPoolOptions(env({ PG_POOL_MAX: '0' })), /PG_POOL_MAX/);
  assert.throws(() => postgresPoolOptions(env({ PG_CONNECTION_TIMEOUT_MS: 'abc' })), /PG_CONNECTION_TIMEOUT_MS/);
});

test('pool factory loads pg lazily, attaches idle error handling and returns the pool', async () => {
  let received, listener;
  class FakePool {
    constructor(options) { received = options; }
    on(name, callback) { assert.equal(name, 'error'); listener = callback; }
  }
  const errors = [];
  const pool = await createPostgresPool({
    env: env({}),
    loadPg: async () => ({ Pool: FakePool }),
    onIdleError: error => errors.push(error.message)
  });
  assert.ok(pool instanceof FakePool);
  assert.equal(received.max, 10);
  listener(new Error('idle socket closed'));
  assert.deepEqual(errors, ['idle socket closed']);
});

test('connection verifier checks database identity and pool close is graceful', async () => {
  const pool = {
    async query(sql) {
      assert.match(sql, /current_database\(\)/);
      return { rows: [{ database: 'marketplace_test', version: 'PostgreSQL 17' }] };
    },
    async end() { this.closed = true; }
  };
  assert.deepEqual(await verifyPostgresConnection(pool), { database: 'marketplace_test', version: 'PostgreSQL 17' });
  await closePostgresPool(pool);
  assert.equal(pool.closed, true);
  await assert.rejects(verifyPostgresConnection({ query: async () => ({ rows: [] }) }), /unexpected result/);
});
