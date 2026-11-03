import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(here, '../apps/api/migrations/postgres');

test('real PostgreSQL applies the complete migration set and is idempotent', {
  skip: !databaseUrl && 'POSTGRES_TEST_DATABASE_URL is not configured'
}, async () => {
  const pool = await createPostgresPool({
    env: {
      DATABASE_URL: databaseUrl,
      PGSSL_MODE: 'disable',
      PG_POOL_MAX: '3',
      PG_CONNECTION_TIMEOUT_MS: '10000'
    }
  });

  try {
    const first = await runPostgresMigrations(pool, migrationDirectory);
    assert.ok(first.current.length > 0, 'At least one PostgreSQL migration must be registered');
    assert.deepEqual(first.applied, first.current, 'A fresh test database should apply every current migration');
    assert.deepEqual(first.unverifiedLegacy, []);

    const second = await runPostgresMigrations(pool, migrationDirectory);
    assert.deepEqual(second.applied, [], 'A second migration pass must not reapply schema changes');
    assert.deepEqual(second.current, first.current);

    const result = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()"
    );
    const tables = new Set(result.rows.map(row => row.table_name));
    for (const table of ['users', 'seller_profiles', 'products', 'orders', 'seller_orders', 'audit_logs']) {
      assert.ok(tables.has(table), 'Expected PostgreSQL table: ' + table);
    }

    const ledger = await pool.query(
      'SELECT name, checksum FROM schema_migrations ORDER BY name'
    );
    assert.equal(ledger.rows.length, first.current.length);
    assert.ok(ledger.rows.every(row => /^[a-f0-9]{64}$/.test(row.checksum)));
  } finally {
    await closePostgresPool(pool);
  }
});
