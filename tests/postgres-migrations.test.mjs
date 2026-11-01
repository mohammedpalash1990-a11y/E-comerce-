import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

function migrationPool({ failOn } = {}) {
  const calls = [], applied = new Set();
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT name FROM schema_migrations')) return { rows: [...applied].map(name => ({ name })), rowCount: applied.size };
      if (sql.startsWith('INSERT INTO schema_migrations')) { applied.add(values[0]); return { rows: [], rowCount: 1 }; }
      if (failOn && sql.includes(failOn)) throw new Error('simulated migration failure');
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE', values: [] }); }
  };
  return { calls, applied, async connect() { return client; } };
}

async function withMigrations(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'haat-migrations-'));
  try {
    for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
    await fn(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('migrations run in filename order, record versions and ignore non-migration files', async () => {
  await withMigrations({
    '002_indexes.sql': 'CREATE INDEX test_idx ON products(id);',
    '001_init.sql': 'CREATE TABLE products(id TEXT PRIMARY KEY);',
    'README.md': 'not SQL'
  }, async dir => {
    const pool = migrationPool();
    const result = await runPostgresMigrations(pool, dir);
    assert.deepEqual(result.applied, ['001_init.sql', '002_indexes.sql']);
    assert.deepEqual(result.current, ['001_init.sql', '002_indexes.sql']);
    assert.ok(pool.calls.findIndex(x => x.sql.startsWith('CREATE TABLE products')) < pool.calls.findIndex(x => x.sql.startsWith('CREATE INDEX')));
    assert.ok(pool.calls.some(x => x.sql.includes('pg_advisory_lock')));
    assert.ok(pool.calls.some(x => x.sql.includes('pg_advisory_unlock')));
    const ledgerInsert = pool.calls.find(x => x.sql.startsWith('INSERT INTO schema_migrations'));
    assert.equal(ledgerInsert.values[0], '001_init.sql');
    assert.match(ledgerInsert.values[1], /^\\d{4}-\\d{2}-\\d{2}T/);
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

test('failed migration rolls back, identifies the file and releases the client', async () => {
  await withMigrations({ '001_init.sql': 'CREATE TABLE products(id TEXT);' }, async dir => {
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
