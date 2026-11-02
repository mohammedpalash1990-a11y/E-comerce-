import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { sha256 } from '../apps/api/src/core.mjs';

function otpHarness() {
  const rows = new Map();
  const statements = [];
  let currentTime = '2026-11-02T00:00:00.000Z';
  let sequence = 0;

  async function query(sql, values = []) {
    statements.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/UPDATE otp_codes SET used_at=\$1 WHERE user_id=\$2 AND purpose=\$3 AND used_at IS NULL/i.test(sql)) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.user_id === values[1] && row.purpose === values[2] && row.used_at === null) {
          row.used_at = values[0];
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }
    if (/INSERT INTO otp_codes/i.test(sql)) {
      const [id, user_id, purpose, code_hash, expires_at, created_at] = values;
      rows.set(id, { id, user_id, purpose, code_hash, attempts: 0, expires_at, used_at: null, created_at });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT \* FROM otp_codes WHERE user_id=\$1 AND purpose=\$2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE/i.test(sql)) {
      const matching = [...rows.values()]
        .filter(row => row.user_id === values[0] && row.purpose === values[1] && row.used_at === null)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { rows: matching.slice(0, 1), rowCount: matching.length ? 1 : 0 };
    }
    if (/UPDATE otp_codes SET attempts=attempts\+1 WHERE id=\$1/i.test(sql)) {
      const row = rows.get(values[0]);
      if (row) row.attempts++;
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE otp_codes SET used_at=\$1 WHERE id=\$2 AND used_at IS NULL/i.test(sql)) {
      const row = rows.get(values[1]);
      if (row && row.used_at === null) row.used_at = values[0];
      return { rows: [], rowCount: row && row.used_at === values[0] ? 1 : 0 };
    }
    throw new Error('Unexpected SQL in OTP regression test: ' + sql);
  }

  const pool = {
    query,
    async connect() {
      return { query, release() {} };
    }
  };
  const database = createPostgresDatabase(pool);
  const auth = createPostgresAuthRepository(database, {
    id: () => 'otp-' + (++sequence),
    now: () => currentTime,
    sha256,
    randomInt: () => 123456
  });
  return {
    auth,
    rows,
    statements,
    setNow(value) { currentTime = value; }
  };
}

test('PostgreSQL OTP consumes a valid code once and rejects replay', async () => {
  const h = otpHarness();
  const code = await h.auth.issueOtp('user-1', 'PHONE');

  await h.auth.checkOtp('user-1', 'PHONE', code);
  const row = [...h.rows.values()][0];
  assert.ok(row.used_at);
  assert.equal(row.attempts, 1);
  await assert.rejects(h.auth.checkOtp('user-1', 'PHONE', code), /মেয়াদোত্তীর্ণ বা অবৈধ/);
  assert.equal(row.attempts, 1);
  assert.ok(h.statements.some(sql => /FOR UPDATE$/i.test(sql)), 'OTP lookup must lock the selected row');
});

test('PostgreSQL OTP persists exactly five failed attempts and blocks the sixth attempt', async () => {
  const h = otpHarness();
  const code = await h.auth.issueOtp('user-2', 'RESET');

  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(h.auth.checkOtp('user-2', 'RESET', '000000'), /কোড সঠিক নয়/);
    assert.equal([...h.rows.values()][0].attempts, attempt);
  }

  await assert.rejects(h.auth.checkOtp('user-2', 'RESET', code), /মেয়াদোত্তীর্ণ বা অবৈধ/);
  assert.equal([...h.rows.values()][0].attempts, 5);
  assert.equal([...h.rows.values()][0].used_at, null);
});

test('PostgreSQL OTP rejects expired codes without incrementing attempts', async () => {
  const h = otpHarness();
  const code = await h.auth.issueOtp('user-3', 'EMAIL');
  const row = [...h.rows.values()][0];
  row.expires_at = '2026-11-01T23:59:59.000Z';
  h.setNow('2026-11-02T00:00:00.000Z');

  await assert.rejects(h.auth.checkOtp('user-3', 'EMAIL', code), /মেয়াদোত্তীর্ণ বা অবৈধ/);
  assert.equal(row.attempts, 0);
  assert.equal(row.used_at, null);
});
