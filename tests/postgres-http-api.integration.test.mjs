import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresPool, verifyPostgresConnection, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresCatalogRepository } from '../apps/api/src/postgres-catalog.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { createPostgresCustomerRepository } from '../apps/api/src/postgres-customer.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';
import { createPostgresApiServer } from '../apps/api/src/postgres-server.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const migrationDirectory = new URL('../apps/api/migrations/postgres/', import.meta.url).pathname;

test('real PostgreSQL HTTP API serves health/catalog and enforces browser-origin and auth boundaries', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL HTTP integration test not run'
}, async () => {
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PGSSL_MODE: 'disable',
    NODE_ENV: 'test',
    CORS_ORIGINS: 'https://shop.example.test'
  };
  const pool = await createPostgresPool({ env });
  let server;
  try {
    const connection = await verifyPostgresConnection(pool);
    assert.match(connection.version, /^PostgreSQL\s/i);
    await runPostgresMigrations(pool, migrationDirectory);

    const database = createPostgresDatabase(pool);
    server = createPostgresApiServer({
      database,
      catalogRepository: createPostgresCatalogRepository(database),
      authRepository: createPostgresAuthRepository(database),
      customerRepository: createPostgresCustomerRepository(database),
      env
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = 'http://127.0.0.1:' + address.port;

    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(health.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), {
      ok: true,
      service: 'marketplace-api',
      db: 'ok',
      runtime: 'postgresql'
    });

    const catalog = await fetch(base + '/api/v1/categories', {
      headers: { origin: 'https://shop.example.test' }
    });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.headers.get('access-control-allow-origin'), 'https://shop.example.test');
    assert.ok(Array.isArray((await catalog.json()).data));

    const allowedPreflight = await fetch(base + '/api/v1/products', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://shop.example.test',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get('vary'), 'Origin');

    const deniedPreflight = await fetch(base + '/api/v1/products', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://untrusted.example.test',
        'access-control-request-method': 'GET'
      }
    });
    assert.equal(deniedPreflight.status, 403);
    assert.equal(deniedPreflight.headers.get('access-control-allow-origin'), null);

    const protectedAdminRoute = await fetch(base + '/api/v1/admin/sellers');
    assert.equal(protectedAdminRoute.status, 401);
  } finally {
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await closePostgresPool(pool);
  }
});
