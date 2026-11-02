import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, postgresPoolOptions, verifyPostgresConnection, closePostgresPool } from './postgres-pool.mjs';
import { createPostgresDatabase } from './postgres-runtime.mjs';
import { createPostgresCatalogRepository } from './postgres-catalog.mjs';
import { runPostgresMigrations } from './postgres-migrations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(here, '../migrations/postgres');

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function safeHeaders(origin, env) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-resource-policy': 'same-site',
    'x-permitted-cross-domain-policies': 'none',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
  };
  const allowed = String(env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    Object.assign(headers, {
      'access-control-allow-origin': origin,
      vary: 'Origin',
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-max-age': '600'
    });
  }
  return headers;
}

function routeError(error, res, headers) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  const message = status === 500 ? 'Internal server error' : String(error.message || 'Request failed');
  if (status === 500) console.error('[postgres api error]', error);
  json(res, status, { error: message }, headers);
}

export function createPostgresApiServer({ database, catalogRepository, env = process.env } = {}) {
  if (!database || typeof database.q !== 'function') {
    throw new TypeError('A PostgreSQL database adapter is required');
  }
  if (!catalogRepository) throw new TypeError('A PostgreSQL catalog repository is required');

  return http.createServer(async (req, res) => {
    const headers = safeHeaders(req.headers.origin, env);
    if (req.method === 'OPTIONS') {
      return res.writeHead(headers['access-control-allow-origin'] ? 204 : 403, headers).end();
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' }, headers);

    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/health') {
        await database.q('SELECT 1 AS ok').get();
        return json(res, 200, { ok: true, service: 'marketplace-api', db: 'ok', runtime: 'postgresql' }, headers);
      }
      if (path === '/api/v1/categories') return json(res, 200, { data: await catalogRepository.listCategories() }, headers);
      if (path === '/api/v1/brands') return json(res, 200, { data: await catalogRepository.listBrands() }, headers);
      if (path === '/api/v1/products') return json(res, 200, { data: await catalogRepository.listProducts(url.searchParams) }, headers);
      if (path === '/api/v1/products/suggest') return json(res, 200, { data: await catalogRepository.suggestProducts(url.searchParams) }, headers);

      const reviews = path.match(/^\/api\/v1\/products\/([^/]+)\/reviews$/);
      if (reviews) return json(res, 200, { data: await catalogRepository.listReviews(decodeURIComponent(reviews[1])) }, headers);

      const product = path.match(/^\/api\/v1\/products\/([^/]+)$/);
      if (product) {
        const value = await catalogRepository.getProduct(decodeURIComponent(product[1]));
        if (!value) return json(res, 404, { error: 'Product not found' }, headers);
        return json(res, 200, { data: value }, headers);
      }
      return json(res, 404, { error: 'Not found' }, headers);
    } catch (error) {
      return routeError(error, res, headers);
    }
  });
}

export async function createPostgresApi({
  env = process.env,
  createPool = options => createPostgresPool(options),
  verifyConnection = verifyPostgresConnection,
  migrate = runPostgresMigrations,
  createServer = createPostgresApiServer
} = {}) {
  // This runtime currently exposes health and public catalog routes only.
  // Never allow an incomplete domain surface to run as a production API.
  if (env.NODE_ENV === 'production') {
    throw new Error('PostgreSQL API is incomplete; production startup remains blocked until auth, customer, seller, admin, payment and delivery routes are integrated and verified');
  }
  // Validate configuration before loading the pg driver or opening any socket.
  postgresPoolOptions(env);
  const pool = await createPool({ env });
  try {
    const connection = await verifyConnection(pool);
    const migrationResult = env.PG_AUTO_MIGRATE === '0'
      ? null
      : await migrate(pool, migrationDirectory);
    const database = createPostgresDatabase(pool);
    const catalogRepository = createPostgresCatalogRepository(database);
    const server = createServer({ database, catalogRepository, env });
    return { pool, server, connection, migrationResult };
  } catch (error) {
    await closePostgresPool(pool);
    throw error;
  }
}

export async function startPostgresApi({ env = process.env, ...options } = {}) {
  const app = await createPostgresApi({ env, ...options });
  const port = Number(env.PORT || 3000);
  const host = env.HOST || '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    await closePostgresPool(app.pool);
    throw new TypeError('PORT must be an integer between 1 and 65535');
  }
  try {
    await new Promise((resolveListen, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, host, resolveListen);
    });
  } catch (error) {
    await closePostgresPool(app.pool);
    throw error;
  }
  const address = app.server.address();
  console.log('[postgres api] listening on ' + (typeof address === 'object' ? address.port : port));
  return {
    ...app,
    async close() {
      await new Promise((resolveClose, reject) => app.server.close(error => error ? reject(error) : resolveClose()));
      await closePostgresPool(app.pool);
    }
  };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  startPostgresApi().then(app => {
    const shutdown = async () => {
      try { await app.close(); process.exitCode = 0; }
      catch (error) { console.error('[postgres api] shutdown failed', error); process.exitCode = 1; }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch(error => {
    console.error('[postgres api] startup failed:', error.message);
    process.exitCode = 1;
  });
}
