import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');

// A deterministic transaction/row-lock test double. Transactions are queued in
// arrival order, modelling PostgreSQL's SELECT ... FOR UPDATE serialization.
function createOtpDatabase(seed) {
  const state = { otp: { ...seed } };
  let tail = Promise.resolve();
  const statements = [];

  const database = {
    q(sql) {
      return {
        get: async (...params) => {
          statements.push(sql);
          if (/SELECT \* FROM otp_codes/i.test(sql)) {
            const [userId, purpose] = params;
            const row = state.otp;
            return row.user_id === userId && row.purpose === purpose && row.used_at == null
              ? { ...row }
              : undefined;
          }
          if (/SELECT attempts FROM otp_codes/i.test(sql)) return { attempts: state.otp.attempts };
          throw new Error('Unexpected OTP test query: ' + sql);
        },
        run: async (...params) => {
          statements.push(sql);
          if (/UPDATE otp_codes SET attempts=attempts\+1 WHERE id=\?/i.test(sql)) {
            if (state.otp.id === params[0]) state.otp.attempts += 1;
            return { changes: 1 };
          }
          if (/UPDATE otp_codes SET used_at=\? WHERE id=\? AND used_at IS NULL/i.test(sql)) {
            const [usedAt, id] = params;
            if (state.otp.id === id && state.otp.used_at == null) state.otp.used_at = usedAt;
            return { changes: 1 };
          }
          throw new Error('Unexpected OTP test update: ' + sql);
        }
      };
    },
    async tx(callback) {
      const previous = tail;
      let release;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      try { return await callback(); }
      finally { release(); }
    }
  };

  return { database, state, statements };
}

function fixture(overrides = {}) {
  const now = '2026-11-01T12:00:00.000Z';
  const { database, state, statements } = createOtpDatabase({
    id: 'otp-1',
    user_id: 'user-1',
    purpose: 'PHONE',
    code_hash: sha256('123456user-1'),
    attempts: 0,
    expires_at: '2026-11-01T12:15:00.000Z',
    used_at: null,
    created_at: '2026-11-01T11:59:00.000Z',
    ...overrides
  });
  const auth = createPostgresAuthRepository(database, { now: () => now });
  return { auth, state, statements };
}

test('concurrent valid OTP submissions: exactly one succeeds and the code is consumed once', async () => {
  const { auth, state, statements } = fixture();
  const results = await Promise.allSettled([
    auth.checkOtp('user-1', 'PHONE', '123456'),
    auth.checkOtp('user-1', 'PHONE', '123456')
  ]);

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(state.otp.attempts, 1);
  assert.ok(state.otp.used_at);
  assert.ok(statements.some(sql => /FOR UPDATE/i.test(sql)), 'OTP row must be selected FOR UPDATE');
});

test('concurrent wrong codes cannot exceed the five-attempt limit', async () => {
  const { auth, state } = fixture();
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => auth.checkOtp('user-1', 'PHONE', '000000'))
  );

  assert.equal(state.otp.attempts, 5);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.message === 'কোড সঠিক নয়').length, 5);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.message === 'কোড মেয়াদোত্তীর্ণ বা অবৈধ').length, 15);
});

test('expired OTP is rejected without consuming an attempt', async () => {
  const { auth, state } = fixture({ expires_at: '2026-11-01T11:59:59.000Z' });
  await assert.rejects(
    auth.checkOtp('user-1', 'PHONE', '123456'),
    error => error.message === 'কোড মেয়াদোত্তীর্ণ বা অবৈধ'
  );
  assert.equal(state.otp.attempts, 0);
  assert.equal(state.otp.used_at, null);
});

test('a successfully used OTP cannot be replayed', async () => {
  const { auth, state } = fixture();
  await auth.checkOtp('user-1', 'PHONE', '123456');
  await assert.rejects(
    auth.checkOtp('user-1', 'PHONE', '123456'),
    error => error.message === 'কোড মেয়াদোত্তীর্ণ বা অবৈধ'
  );
  assert.equal(state.otp.attempts, 1);
});
