import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostgresPool, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const databaseEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  PGSSL_MODE: 'disable',
  PG_POOL_MAX: '2',
  PG_CONNECTION_TIMEOUT_MS: '10000'
};

async function withMigrations(files, run) {
  const directory = await mkdtemp(join(tmpdir(), 'haat-postgres-migration-contract-'));
  try {
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(join(directory, name), sql);
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withIsolatedSchema(run) {
  const adminPool = await createPostgresPool({ env: databaseEnv });
  const schema = 'haat_mig_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const scopedPools = [];
  let schemaCreated = false;
  try {
    await adminPool.query('CREATE SCHEMA "' + schema + '"');
    schemaCreated = true;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', '-c search_path=' + schema);
    const makePool = async () => {
      const pool = await createPostgresPool({
        env: { ...databaseEnv, DATABASE_URL: scopedUrl.toString() }
      });
      scopedPools.push(pool);
      return pool;
    };
    await run({ makePool, schema });
  } finally {
    for (const pool of scopedPools) await closePostgresPool(pool);
    if (schemaCreated) {
      await adminPool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    }
    await closePostgresPool(adminPool);
  }
}

test('real PostgreSQL advisory lock serializes concurrent migration runners', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL integration test not run'
}, async () => {
  await withMigrations({
    '001_create_contract.sql': [
      'CREATE TABLE migration_contract (id INTEGER PRIMARY KEY, label TEXT NOT NULL);',
      "INSERT INTO migration_contract (id, label) VALUES (1, 'first');"
    ].join('\n'),
    '002_add_second_row.sql': "INSERT INTO migration_contract (id, label) VALUES (2, 'second');"
  }, async directory => {
    await withIsolatedSchema(async ({ makePool }) => {
      const [firstPool, secondPool] = await Promise.all([makePool(), makePool()]);
      const results = await Promise.all([
        runPostgresMigrations(firstPool, directory),
        runPostgresMigrations(secondPool, directory)
      ]);
      assert.deepEqual(results.map(result => result.applied.length).sort((a, b) => a - b), [0, 2]);
      const ledger = await firstPool.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
      assert.deepEqual(ledger.rows.map(row => row.name), ['001_create_contract.sql', '002_add_second_row.sql']);
      assert.ok(ledger.rows.every(row => /^[a-f0-9]{64}$/.test(row.checksum)));
      const rows = await firstPool.query('SELECT id, label FROM migration_contract ORDER BY id');
      assert.deepEqual(rows.rows, [{ id: 1, label: 'first' }, { id: 2, label: 'second' }]);
    });
  });
});

test('real PostgreSQL rolls back a failed migration and does not record it', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL integration test not run'
}, async () => {
  await withMigrations({
    '001_create_committed.sql': 'CREATE TABLE committed_contract (id INTEGER PRIMARY KEY);',
    '002_fail_after_ddl.sql': [
      'CREATE TABLE rolled_back_contract (id INTEGER PRIMARY KEY);',
      'THIS IS NOT VALID SQL;'
    ].join('\n')
  }, async directory => {
    await withIsolatedSchema(async ({ makePool }) => {
      const pool = await makePool();
      await assert.rejects(
        runPostgresMigrations(pool, directory),
        error => error.migration === '002_fail_after_ddl.sql'
      );
      const tables = await pool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()'
      );
      const names = new Set(tables.rows.map(row => row.table_name));
      assert.equal(names.has('committed_contract'), true);
      assert.equal(names.has('rolled_back_contract'), false);
      const ledger = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
      assert.deepEqual(ledger.rows.map(row => row.name), ['001_create_committed.sql']);
    });
  });
});

test('real PostgreSQL rejects a changed applied migration before executing replacement SQL', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL integration test not run'
}, async () => {
  await withMigrations({
    '001_protected_contract.sql': 'CREATE TABLE protected_contract (id INTEGER PRIMARY KEY);'
  }, async directory => {
    await withIsolatedSchema(async ({ makePool }) => {
      const pool = await makePool();
      await runPostgresMigrations(pool, directory);
      await writeFile(
        join(directory, '001_protected_contract.sql'),
        'DROP TABLE protected_contract; CREATE TABLE replacement_contract (id INTEGER PRIMARY KEY);'
      );
      await assert.rejects(
        runPostgresMigrations(pool, directory),
        /Migration checksum mismatch for 001_protected_contract\.sql/
      );
      const tables = await pool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()'
      );
      const names = new Set(tables.rows.map(row => row.table_name));
      assert.equal(names.has('protected_contract'), true);
      assert.equal(names.has('replacement_contract'), false);
      const ledger = await pool.query('SELECT name, checksum FROM schema_migrations');
      assert.equal(ledger.rows.length, 1);
      assert.match(ledger.rows[0].checksum, /^[a-f0-9]{64}$/);
    });
  });
});
