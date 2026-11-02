import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, verifyPostgresConnection, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresCatalogRepository } from '../apps/api/src/postgres-catalog.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = resolve(root, 'apps/api/migrations/postgres');

test('real PostgreSQL runtime migrates and exercises catalog plus auth/session repositories', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL integration test not run'
}, async () => {
  // This URL must point to a disposable test database. Migrations are applied to it.
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  const pool = await createPostgresPool({ env });
  let createdUserId = null;
  try {
    const connection = await verifyPostgresConnection(pool);
    assert.match(connection.version, /^PostgreSQL\s/i);
    await runPostgresMigrations(pool, migrationDirectory);
    const database = createPostgresDatabase(pool);
    assert.equal((await database.q('SELECT 1 AS value').get()).value, 1);

    const catalog = createPostgresCatalogRepository(database);
    assert.ok(Array.isArray(await catalog.listCategories()));
    assert.ok(Array.isArray(await catalog.listBrands()));
    assert.ok(Array.isArray(await catalog.listProducts(new URLSearchParams({ limit: '5' }))));

    const auth = createPostgresAuthRepository(database);
    const phone = '017' + String(randomInt(10_000_000, 99_999_999));
    const email = 'pg-integration-' + phone + '@example.test';
    const registered = await auth.registerCustomer({
      name: 'PostgreSQL Integration',
      phone,
      email,
      password: 'Integration@123',
      confirm_password: 'Integration@123'
    });
    createdUserId = registered.data.id;
    assert.ok(registered.token);
    const sessionUser = await auth.getSessionUser(registered.token);
    assert.equal(sessionUser.id, createdUserId);
    assert.equal(sessionUser.role, 'CUSTOMER');

    const login = await auth.login({ identifier: phone, password: 'Integration@123' });
    assert.ok(login.token);
    assert.equal(login.data.id, createdUserId);
    await auth.logout(sessionUser);
    assert.equal(await auth.getSessionUser(registered.token), null);
  } finally {
    if (createdUserId) await pool.query('DELETE FROM users WHERE id=$1', [createdUserId]);
    await closePostgresPool(pool);
  }
});
