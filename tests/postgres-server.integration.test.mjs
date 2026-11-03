import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, verifyPostgresConnection, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresCatalogRepository } from '../apps/api/src/postgres-catalog.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = resolve(root, 'apps/api/migrations/postgres');

test('real PostgreSQL runtime migrates and serves catalog queries', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL integration test not run'
}, async () => {
  // This URL must point to a disposable test database. Migrations are applied to it.
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  const pool = await createPostgresPool({ env });
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
  } finally {
    await closePostgresPool(pool);
  }
});
