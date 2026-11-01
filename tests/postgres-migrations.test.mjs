import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPostgresMigrations, migrationChecksum } from '../apps/api/src/postgres-migrations.mjs';

function migrationPool({ initial = [], failOn } = {}) {
  const calls = [], rows = initial.map(row => ({ ...row }));
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT name, checksum FROM schema_migrations')) return { rows: rows.map(row => ({ ...row })), rowCount: rows.length };
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        rows.push({ name: values[0], checksum: values[2] });
        return { rows: [], rowCount: 1 };
      }
      if (failOn && sql.includes(failOn)) throw new Error('simulated migration failure');
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE', values: [] }); }
  };
  return { calls, rows, async connect() { return client; } };
}

async function withMigrations(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'haat-migrations-'));
  try {
    for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
    await fn(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('migration checksums are stable SHA-256 digests of exact UTF-8 contents', () => {
  assert.equal(migrationChecksum('SELECT 1;'), migrationChecksum('SELECT 1;'));
  assert.notEqual(migrationChecksum('SELECT 1;'), migrationChecksum('SELECT 2;'));
  assert.match(migrationChecksum('SELECT 1;'), /^[a-f0-9]{64}$/);
});

test('migrations run in filename order, record checksums and ignore non-migration files', async () => {
  await withMigrations({
    '002_indexes.sql': 'CREATE INDEX test_idx ON products(id);',
    '001_init.sql': 'CREATE TABLE products(id TEXT PRIMARY KEY);',
    'README.md': 'not SQL'
  }, async dir => {
    const pool = migrationPool();
    const result = await runPostgresMigrations(pool, dir);
    assert.deepEqual(result.applied, ['001_init.sql', '002_indexes.sql']);
    assert.deepEqual(result.current, ['001_init.sql', '002_indexes.sql']);
    assert.deepEqual(result.unverifiedLegacy, []);
    assert.ok(pool.calls.findIndex(x => x.sql.startsWith('CREATE TABLE products')) < pool.calls.findIndex(x => x.sql.startsWith('CREATE INDEX')));
    assert.ok(pool.calls.some(x => x.sql.includes('pg_advisory_lock')));
    assert.ok(pool.calls.some(x => x.sql.includes('pg_advisory_unlock')));
    assert.ok(pool.calls.some(x => x.sql.includes('ADD COLUMN IF NOT EXISTS checksum')));
    const ledgerInsert = pool.calls.find(x => x.sql.startsWith('INSERT INTO schema_migrations'));
    assert.equal(ledgerInsert.values[0], '001_init.sql');
    assert.match(ledgerInsert.values[1], /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(ledgerInsert.values[2], migrationChecksum('CREATE TABLE products(id TEXT PRIMARY KEY);'));
    assert.equal(pool.calls.at(-1).sql, 'RELEASE');
  });
});

test('already applied migrations are skipped on subsequent runs', async () => {
  await withMigrations({ '001_init.sql': 'CREATE TABLE products(id TEXT);' }, async dir => {
    const pool = migrationPool();
    const first = await runPostgresMigrations(pool, dir);
    const second = await runPostgresMigrations(pool, dir);
    assert.deepEqual(first.applied, ['001_init.sql']);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.current, ['001_init.sql']);
  });
});

test('edited applied migrations fail closed before their SQL is executed', async () => {
  const original = 'CREATE TABLE products(id TEXT);';
  await withMigrations({ '001_init.sql': 'DROP TABLE products;' }, async dir => {
    const pool = migrationPool({ initial: [{ name: '001_init.sql', checksum: migrationChecksum(original) }] });
    await assert.rejects(runPostgresMigrations(pool, dir), /Migration checksum mismatch for 001_init.sql/);
    assert.equal(pool.calls.some(x => x.sql === 'DROP TABLE products;'), false);
    assert.equal(pool.calls.at(-1).sql, 'RELEASE');
  });
});

test('legacy rows without checksums remain explicitly unverified and are not rewritten', async () => {
  await withMigrations({ '001_legacy.sql': 'SELECT 1;' }, async dir => {
    const pool = migrationPool({ initial: [{ name: '001_legacy.sql', checksum: null }] });
    const result = await runPostgresMigrations(pool, dir);
    assert.deepEqual(result.unverifiedLegacy, ['001_legacy.sql']);
    assert.equal(pool.rows[0].checksum, null);
    assert.equal(pool.calls.some(x => x.sql === 'SELECT 1;'), false);
  });
});

test('failed migration rolls back, identifies the file and releases the client', async () => {
  await withMigrations({ '001_init.sql': 'CREATE TABLE products(id TEXT PRIMARY KEY);' }, async dir => {
    const pool = migrationPool({ failOn: 'CREATE TABLE products' });
    await assert.rejects(runPostgresMigrations(pool, dir), error => error.migration === '001_init.sql' && /simulated/.test(error.message));
    assert.ok(pool.calls.some(x => x.sql === 'ROLLBACK'));
    assert.ok(pool.calls.some(x => x.sql.includes('pg_advisory_unlock')));
    assert.equal(pool.calls.at(-1).sql, 'RELEASE');
  });
});

test('rejects missing pool and missing migration directory', async () => {
  await assert.rejects(runPostgresMigrations({}, '/tmp'), /Pool is required/);
  await assert.rejects(runPostgresMigrations({ connect() {} }), /directory is required/);
});
