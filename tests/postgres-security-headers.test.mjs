import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresApiServer } from '../apps/api/src/postgres-server.mjs';

async function requestHeaders(env) {
  const database = {
    q() { return { async get() { return { ok: 1 }; }, async all() { return []; }, async run() { return { changes: 0 }; } }; },
    async tx(callback) { return callback(); }
  };
  const server = createPostgresApiServer({
    database,
    catalogRepository: {},
    authRepository: {},
    customerRepository: { async listAddresses() { return []; } },
    env
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/health');
    return response.headers;
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('PostgreSQL API sends baseline browser security headers', async () => {
  const headers = await requestHeaders({ NODE_ENV: 'development' });
  for (const [name, value] of Object.entries({
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-resource-policy': 'same-site',
    'x-permitted-cross-domain-policies': 'none',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
  })) assert.equal(headers.get(name), value, name);
  assert.equal(headers.get('strict-transport-security'), null);
});

test('PostgreSQL API enables HSTS in production', async () => {
  const headers = await requestHeaders({ NODE_ENV: 'production' });
  assert.equal(headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
});
