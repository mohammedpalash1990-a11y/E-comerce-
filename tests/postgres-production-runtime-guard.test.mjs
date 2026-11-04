import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresApi } from '../apps/api/src/postgres-server.mjs';

test('PostgreSQL API refuses production startup before opening a database pool', async () => {
  let poolCreated = false;
  await assert.rejects(
    createPostgresApi({
      env: { NODE_ENV: 'production' },
      createPool: async () => {
        poolCreated = true;
        throw new Error('database pool must not be created');
      }
    }),
    /PostgreSQL API is incomplete; production startup remains blocked/
  );
  assert.equal(poolCreated, false, 'production guard must run before database initialization');
});

test('PostgreSQL API production guard cannot be bypassed by injected runtime dependencies', async () => {
  let serverCreated = false;
  await assert.rejects(
    createPostgresApi({
      env: { NODE_ENV: 'production', DATABASE_URL: 'postgresql://invalid' },
      createPool: async () => ({ end: async () => {} }),
      verifyConnection: async () => ({ ok: true }),
      migrate: async () => ({ applied: [] }),
      createServer: () => {
        serverCreated = true;
        return {};
      }
    }),
    /PostgreSQL API is incomplete; production startup remains blocked/
  );
  assert.equal(serverCreated, false, 'production guard must run before server composition');
});
