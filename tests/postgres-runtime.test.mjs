import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDatabase, isPostgresUniqueViolation } from '../apps/api/src/postgres-runtime.mjs';

function fakePool() {
  const calls = [];
  let nextClient = 0;
  const makeClient = id => ({
    id,
    async query(text, values = []) {
      calls.push({ client: id, text, values });
      if (text === 'SELECT fail') throw Object.assign(new Error('db failure'), { code: 'XX000' });
      if (text === 'SELECT unique') throw Object.assign(new Error('duplicate'), { code: '23505' });
      if (text.startsWith('SELECT')) return { rows: [{ client: id, values }], rowCount: 1 };
      if (text.startsWith('INSERT')) return { rows: [{ id: 'created-id' }], rowCount: 1 };
      return { rows: [], rowCount: 2 };
    },
    release() { calls.push({ client: id, text: 'RELEASE' }); }
  });
  return {
    calls,
    async query(text, values) { return makeClient('pool').query(text, values); },
    async connect() { return makeClient('tx-' + (++nextClient)); }
  };
}

test('PostgreSQL query facade exposes async get/all/run and validates bind count', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  assert.deepEqual(await db.q('SELECT ?').get(7), { client: 'pool', values: [7] });
  assert.deepEqual(await db.q('SELECT ?').all(8), [{ client: 'pool', values: [8] }]);
  assert.deepEqual(await db.q('UPDATE items SET active=?').run(true), { changes: 2, rows: [], lastInsertRowid: null });
  assert.deepEqual(await db.q('INSERT INTO items(id) VALUES(?) RETURNING id').run('x'), { changes: 1, rows: [{ id: 'created-id' }], lastInsertRowid: 'created-id' });
  await assert.rejects(db.q('SELECT ?, ?').get(1), /expects 2 parameters but received 1/);
  assert.equal(pool.calls[0].text, 'SELECT $1');
});

test('transaction pins all async queries to one checked-out client and commits', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  const value = await db.tx(async () => {
    const first = await db.q('SELECT ?').get('a');
    await Promise.resolve();
    const second = await db.q('SELECT ?').get('b');
    return [first.client, second.client];
  });
  assert.deepEqual(value, ['tx-1', 'tx-1']);
  assert.deepEqual(pool.calls.map(x => x.text), ['BEGIN', 'SELECT $1', 'SELECT $1', 'COMMIT', 'RELEASE']);
});

test('transaction rolls back after callback errors and always releases client', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  await assert.rejects(db.tx(async () => { await db.q('SELECT 1').get(); throw new Error('abort'); }), /abort/);
  assert.deepEqual(pool.calls.map(x => x.text), ['BEGIN', 'SELECT 1', 'ROLLBACK', 'RELEASE']);
});

test('nested transactions use savepoints and can roll back independently', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  await db.tx(async () => {
    await db.q('SELECT 1').get();
    await assert.rejects(db.tx(async () => { await db.q('SELECT fail').get(); }), /db failure/);
    await db.q('SELECT 2').get();
  });
  assert.deepEqual(pool.calls.map(x => x.text), [
    'BEGIN', 'SELECT 1', 'SAVEPOINT sp_1', 'SELECT fail',
    'ROLLBACK TO SAVEPOINT sp_1', 'RELEASE SAVEPOINT sp_1',
    'SELECT 2', 'COMMIT', 'RELEASE'
  ]);
});

test('concurrent transactions keep their clients isolated', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  const [a, b] = await Promise.all([
    db.tx(async () => { await new Promise(r => setTimeout(r, 5)); return (await db.q('SELECT 1').get()).client; }),
    db.tx(async () => (await db.q('SELECT 2').get()).client)
  ]);
  assert.notEqual(a, b);
});

test('PostgreSQL unique constraint errors are recognized by SQLSTATE', () => {
  assert.equal(isPostgresUniqueViolation({ code: '23505' }), true);
  assert.equal(isPostgresUniqueViolation({ code: '23503' }), false);
  assert.equal(isPostgresUniqueViolation(new Error('UNIQUE constraint failed')), false);
});


test('adapter rejects an invalid pool before exposing query methods', () => {
  assert.throws(() => createPostgresDatabase({ query() {} }), /query\(\) and connect\(\)/);
  assert.throws(() => createPostgresDatabase(null), /query\(\) and connect\(\)/);
});

test('query facade rejects empty and non-string SQL before touching the pool', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  assert.throws(() => db.q('   '), /non-empty string/);
  assert.throws(() => db.q(null), /non-empty string/);
  assert.equal(pool.calls.length, 0);
});

test('parameter mismatch is rejected before a database round trip', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  await assert.rejects(db.q('SELECT ?, ?').all(1), /expects 2 parameters but received 1/);
  await assert.rejects(db.q('SELECT ?').run(1, 2), /expects 1 parameters but received 2/);
  assert.equal(pool.calls.length, 0);
});

test('nested transaction success releases its savepoint without committing the outer transaction', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  await db.tx(async () => {
    await db.q('SELECT 1').get();
    await db.tx(async () => db.q('SELECT 2').get());
    await db.q('SELECT 3').get();
  });
  assert.deepEqual(pool.calls.map(x => x.text), [
    'BEGIN', 'SELECT 1', 'SAVEPOINT sp_1', 'SELECT 2',
    'RELEASE SAVEPOINT sp_1', 'SELECT 3', 'COMMIT', 'RELEASE'
  ]);
});

test('outer transaction rollback also undoes a successful nested savepoint', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  await assert.rejects(db.tx(async () => {
    await db.tx(async () => db.q('SELECT 1').get());
    throw new Error('outer abort');
  }), /outer abort/);
  assert.deepEqual(pool.calls.map(x => x.text), [
    'BEGIN', 'SAVEPOINT sp_1', 'SELECT 1', 'RELEASE SAVEPOINT sp_1', 'ROLLBACK', 'RELEASE'
  ]);
});

test('synchronous transaction callback results are returned after commit', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  assert.equal(await db.tx(() => 42), 42);
  assert.deepEqual(pool.calls.map(x => x.text), ['BEGIN', 'COMMIT', 'RELEASE']);
});

test('failed BEGIN still releases the checked-out client', async () => {
  const calls = [];
  const pool = {
    async query() { throw new Error('pool query should not be used'); },
    async connect() { return {
      async query(sql) { calls.push(sql); if (sql === 'BEGIN') throw new Error('begin failed'); },
      release() { calls.push('RELEASE'); }
    }; }
  };
  const db = createPostgresDatabase(pool);
  await assert.rejects(db.tx(async () => 1), /begin failed/);
  assert.deepEqual(calls, ['BEGIN', 'RELEASE']);
});

test('failed COMMIT attempts rollback and releases the client', async () => {
  const calls = [];
  const pool = {
    async query() { throw new Error('pool query should not be used'); },
    async connect() { return {
      async query(sql) { calls.push(sql); if (sql === 'COMMIT') throw new Error('commit failed'); },
      release() { calls.push('RELEASE'); }
    }; }
  };
  const db = createPostgresDatabase(pool);
  await assert.rejects(db.tx(async () => 1), /commit failed/);
  assert.deepEqual(calls, ['BEGIN', 'COMMIT', 'ROLLBACK', 'RELEASE']);
});

test('nested transaction savepoint identifiers remain unique across sequential nesting', async () => {
  const pool = fakePool(), db = createPostgresDatabase(pool);
  await db.tx(async () => {
    await db.tx(async () => 1);
    await db.tx(async () => 2);
  });
  assert.ok(pool.calls.some(x => x.text === 'SAVEPOINT sp_1'));
  assert.ok(pool.calls.some(x => x.text === 'SAVEPOINT sp_2'));
});
