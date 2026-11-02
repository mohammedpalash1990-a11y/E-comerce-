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

test('real PostgreSQL enforces case-insensitive seller shop uniqueness under concurrent registration', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; concurrent uniqueness integration test not run'
}, async () => {
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  const pool = await createPostgresPool({ env });
  const suffix = String(randomInt(10_000_000, 99_999_999));
  const phones = ['017' + suffix, '018' + suffix];
  const shopName = 'Concurrent Shop ' + suffix;
  try {
    await verifyPostgresConnection(pool);
    await runPostgresMigrations(pool, migrationDirectory);
    const auth = createPostgresAuthRepository(createPostgresDatabase(pool));
    const registrations = phones.map((phone, index) => auth.registerSeller({
      name: 'Concurrent Seller ' + index,
      phone,
      email: 'pg-shop-' + suffix + '-' + index + '@example.test',
      password: 'Integration@123',
      confirm_password: 'Integration@123',
      shop_name: index === 0 ? shopName : shopName.toLowerCase(),
      shop_address: 'Dhaka',
      business_info: 'Disposable PostgreSQL integration fixture',
      kyc_nid: '1234567890123'
    }));
    const results = await Promise.allSettled(registrations);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one concurrent registration should create the case-insensitive shop name');
    assert.equal(rejected.length, 1, 'the competing registration should be rejected by the unique index');
    assert.equal(rejected[0].reason.code, '23505');
  } finally {
    await pool.query('DELETE FROM users WHERE phone = ANY($1::text[])', [phones]);
    await closePostgresPool(pool);
  }
});
