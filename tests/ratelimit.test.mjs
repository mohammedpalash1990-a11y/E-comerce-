import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi } from './helpers.mjs';

test('auth endpoints are rate limited', async () => {
  const api = await startApi(4419, { RATE_LIMIT_AUTH_MAX: '4' });
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await api.login('01700000003', 'wrong-password')).status);
    assert.deepEqual(codes.slice(0, 4), [401, 401, 401, 401]);
    assert.ok(codes.slice(4).every(c => c === 429), 'later attempts are throttled: ' + codes);
  } finally { api.stop(); }
});
