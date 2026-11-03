import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const entry = "import('./apps/api/src/core.mjs')";

function importCore(overrides = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PAYMENT_WEBHOOK_SECRET: 'test-only-secret',
    SQLITE_FILE: ':memory:',
    ...overrides
  };
  return spawnSync(process.execPath, ['--input-type=module', '-e', entry], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 10_000
  });
}

test('production startup fails closed when DATABASE_URL is configured but PostgreSQL runtime is unavailable', () => {
  const result = importCore({ DATABASE_URL: 'postgresql://marketplace:test@127.0.0.1:5432/marketplace' });
  assert.notEqual(result.status, 0, 'production import must fail');
  assert.match(result.stderr, /PostgreSQL runtime adapter is not implemented; production startup is blocked/);
});

test('production startup fails closed when the API would otherwise use SQLite', () => {
  const result = importCore({ DATABASE_URL: '' });
  assert.notEqual(result.status, 0, 'production import must fail');
  assert.match(result.stderr, /Production startup is blocked: current API runtime uses SQLite/);
});

test('production startup rejects a missing payment webhook secret before database initialization', () => {
  const result = importCore({ PAYMENT_WEBHOOK_SECRET: '', DATABASE_URL: '' });
  assert.notEqual(result.status, 0, 'production import must fail');
  assert.match(result.stderr, /PAYMENT_WEBHOOK_SECRET is required in production/);
});


test('canonical API entrypoint remains fail-closed in production until PostgreSQL routes replace SQLite', () => {
  const result = spawnSync(process.execPath, ['apps/api/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PAYMENT_WEBHOOK_SECRET: 'test-only-long-secret',
      SQLITE_FILE: ':memory:',
      DATABASE_URL: ''
    },
    encoding: 'utf8',
    timeout: 10_000
  });

  assert.notEqual(result.status, 0, 'canonical API entrypoint must not start in production on SQLite');
  assert.match(result.stderr, /Production startup is blocked: current API runtime uses SQLite/);
  assert.doesNotMatch(result.stderr, /EADDRINUSE|listen EACCES/);
});
