import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { config } from '../apps/api/src/postgres-shared.mjs';

function fixture() {
  const calls = [];
  let transactionDepth = 0;
  let transactionCount = 0;
  const database = {
    q(sql) {
      return {
        async get(...params) {
          calls.push({ sql, params, inTransaction: transactionDepth > 0 });
          return { id: params[0] };
        },
        async run(...params) {
          calls.push({ sql, params, inTransaction: transactionDepth > 0 });
          return { rowCount: 1 };
        }
      };
    },
    async tx(callback) {
      transactionCount++;
      transactionDepth++;
      try { return await callback(); }
      finally { transactionDepth--; }
    }
  };
  const now = '2026-11-02T04:00:00.000Z';
  const auth = createPostgresAuthRepository(database, {
    id: () => 'fixed-id',
    now: () => now,
    sha256: value => 'sha256:' + value,
    randomInt: () => 123456,
    randomBytes: () => ({ toString: () => 't'.repeat(64) })
  });
  return { auth, calls, now, get transactionCount() { return transactionCount; } };
}

test('OTP invalidation and replacement insert run inside one transaction using injected time', async () => {
  const f = fixture();
  const code = await f.auth.issueOtp('user-1', 'PHONE');
  assert.equal(code, '123456');
  assert.equal(f.transactionCount, 1);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[0].sql, /^SELECT id FROM users WHERE id=\? FOR UPDATE$/);
  assert.match(f.calls[1].sql, /^UPDATE otp_codes SET used_at=/);
  assert.match(f.calls[2].sql, /^INSERT INTO otp_codes/);
  assert.ok(f.calls.every(call => call.inTransaction), 'user lock and OTP replacement must share the transaction');
  assert.deepEqual(f.calls[0].params, ['user-1']);
  assert.deepEqual(f.calls[1].params, [f.now, 'user-1', 'PHONE']);
  assert.deepEqual(f.calls[2].params, [
    'fixed-id', 'user-1', 'PHONE', 'sha256:123456user-1',
    new Date(Date.parse(f.now) + 15 * 60_000).toISOString(), f.now
  ]);
});

test('session expiry is calculated from the injected clock and inserted transactionally', async () => {
  const f = fixture();
  const token = await f.auth.createSession('user-1');
  assert.equal(token, 't'.repeat(64));
  assert.equal(f.transactionCount, 1);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].inTransaction);
  assert.deepEqual(f.calls[0].params, [
    'sha256:' + token,
    'user-1',
    new Date(Date.parse(f.now) + config.sessionDays * 86_400_000).toISOString(),
    f.now
  ]);
});
