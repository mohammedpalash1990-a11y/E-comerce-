import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('production mode fails closed while SQLite is the only runtime adapter', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./apps/api/src/core.mjs')"], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PAYMENT_WEBHOOK_SECRET: 'test-only-long-secret',
      SQLITE_FILE: ':memory:',
      DATABASE_URL: ''
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production startup is blocked: current API runtime uses SQLite/);
});

test('production mode does not silently claim a DATABASE_URL enables PostgreSQL', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./apps/api/src/core.mjs')"], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PAYMENT_WEBHOOK_SECRET: 'test-only-long-secret',
      SQLITE_FILE: ':memory:',
      DATABASE_URL: 'postgresql://example.invalid/db'
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PostgreSQL runtime adapter is not implemented/);
});
