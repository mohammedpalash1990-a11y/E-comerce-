import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, postgresPoolOptions, verifyPostgresConnection, closePostgresPool } from './postgres-pool.mjs';
import { createPostgresDatabase } from './postgres-runtime.mjs';
import { createPostgresCatalogRepository } from './postgres-catalog.mjs';
import { registerPostgresCatalogRoutes } from './postgres-catalog-routes.mjs';
import { createPostgresAuthRepository } from './postgres-auth.mjs';
import { createPostgresCustomerRepository } from './postgres-customer.mjs';
import { handlePostgresInventoryWorkspace } from './postgres-inventory-workspace.mjs';
import { registerPostgresCommerceRoutes } from './postgres-commerce-routes.mjs';
import { registerPostgresAdminSellerRoutes } from './postgres-admin-seller-routes.mjs';
import { registerPostgresSellerWorkspaceRoutes } from './postgres-seller-workspace-routes.mjs';
import { registerPostgresSellerProductRoutes } from './postgres-seller-product-routes.mjs';
import { registerPostgresAdminProductRoutes } from './postgres-admin-product-routes.mjs';
import { registerPostgresPayoutRoutes } from './postgres-payout-routes.mjs';
import { registerPostgresAdminDashboardRoutes } from './postgres-admin-dashboard-routes.mjs';
import { registerPostgresAdminOrderRoutes } from './postgres-admin-order-routes.mjs';
import { createPostgresInventoryRepository } from './postgres-inventory.mjs';
import { runPostgresMigrations } from './postgres-migrations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(here, '../migrations/postgres');
const MAX_BODY_BYTES = 64 * 1024;
const AUTH_WINDOW_MS = 60_000;

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function safeHeaders(origin, env) {
  const headers = {
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-resource-policy': 'same-site', 'x-permitted-cross-domain-policies': 'none',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
  };
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  const allowed = String(env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) Object.assign(headers, {
    'access-control-allow-origin': origin, vary: 'Origin',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600'
  });
  return headers;
}
function routeError(error, res, headers) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : error?.code === '23505' ? 409 : 500;
  const message = status === 500 ? 'Internal server error' : status === 409 && error?.code === '23505' ? 'ডুপ্লিকেট তথ্য পাওয়া গেছে' : String(error.message || 'Request failed');
  if (status === 500) console.error('[postgres api error]', error);
  json(res, status, { error: message, ...(status !== 500 && error?.extra ? error.extra : {}) }, headers);
}
async function readJsonBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  const chunks = []; let size = 0;
  let tooLarge = Number.isFinite(declared) && declared > MAX_BODY_BYTES;
  // Drain the request even after the limit is exceeded so the server can return
  // a deterministic 413 instead of resetting the client connection.
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) tooLarge = true;
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) throw Object.assign(new Error('Payload too large'), { status: 413 });
  if (!size) return {};
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('JSON body must be an object'), { status: 400 });
  return value;
}
function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9_-]{32,256})$/i);
  return match?.[1] || null;
}
// Per-process defense-in-depth only. Multi-instance deployments must also apply
// a shared rate limit at the trusted edge/API gateway.
function createAuthRateLimiter() {
  const buckets = new Map();
  return (key, path, now = Date.now()) => {
    const limits = {
      '/api/v1/auth/login': 12, '/api/v1/auth/register': 5, '/api/v1/auth/register-seller': 5,
      '/api/v1/auth/forgot-password': 8, '/api/v1/auth/reset-password': 8,
      '/api/v1/auth/send-verification': 8, '/api/v1/auth/verify': 10
    };
    const limit = limits[path] || 30, bucketKey = key + ':' + path;
    const recent = (buckets.get(bucketKey) || []).filter(time => now - time < AUTH_WINDOW_MS);
    if (recent.length >= limit) { buckets.set(bucketKey, recent); return false; }
    recent.push(now);
    if (!buckets.has(bucketKey) && buckets.size >= 5000) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(bucketKey, recent); return true;
  };
}
function decodePathPart(value) {
  try { return decodeURIComponent(value); }
  catch { throw Object.assign(new Error('Invalid URL encoding'), { status: 400 }); }
}

export function createPostgresApiServer({ database, catalogRepository, authRepository, customerRepository, env = process.env } = {}) {
  if (!database || typeof database.q !== 'function') throw new TypeError('A PostgreSQL database adapter is required');
  if (!catalogRepository) throw new TypeError('A PostgreSQL catalog repository is required');
  if (!authRepository) throw new TypeError('A PostgreSQL auth repository is required');
  if (!customerRepository) throw new TypeError('A PostgreSQL customer repository is required');
  const allowAuthRequest = createAuthRateLimiter();
  const domainRoutes = [];
  const registerDomainRoute = (routeMethod, pattern, roles, handler, opts = {}) => {
    // Preserve the richer inventory-adjustment workspace already mounted below.
    if (pattern.startsWith('/api/v1/seller/inventory')) return;
    const routePattern = pattern.split('/').map(segment => segment.startsWith(':') ? '([^/]+)' : segment).join('/');
    domainRoutes.push({ method: routeMethod, re: new RegExp('^' + routePattern + '$'), roles, handler, limit: opts.limit || MAX_BODY_BYTES });
  };
  const response = (data, status = 200) => ({ status, body: { data } });
  registerPostgresCommerceRoutes(registerDomainRoute, response, {
    database,
    inventoryRepository: createPostgresInventoryRepository(database)
  });
  registerPostgresAdminSellerRoutes(registerDomainRoute, response, { database });
  registerPostgresSellerWorkspaceRoutes(registerDomainRoute, response, { database });
  registerPostgresSellerProductRoutes(registerDomainRoute, response, { database });
  registerPostgresAdminProductRoutes(registerDomainRoute, response, { database });
  registerPostgresPayoutRoutes(registerDomainRoute, response, { database });
  registerPostgresAdminDashboardRoutes(registerDomainRoute, response, { database });
  registerPostgresAdminOrderRoutes(registerDomainRoute, response, { database });
  registerPostgresCatalogRoutes(registerDomainRoute, response, { catalogRepository });

  return http.createServer(async (req, res) => {
    const headers = safeHeaders(req.headers.origin, env);
    if (req.method === 'OPTIONS') return res.writeHead(headers['access-control-allow-origin'] ? 204 : 403, headers).end();
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      const forwardedIp = env.TRUST_PROXY === '1'
        ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        : '';
      const ip = forwardedIp || req.socket.remoteAddress || 'unknown';
      if (path.startsWith('/api/v1/auth/') && !allowAuthRequest(ip, path)) {
        res.setHeader('retry-after', '60');
        return json(res, 429, { error: 'অনেক বেশি চেষ্টা হয়েছে, কিছুক্ষণ পরে আবার চেষ্টা করুন' }, headers);
      }
      const method = req.method;
      if (method === 'GET' && path === '/health') {
        await database.q('SELECT 1 AS ok').get();
        return json(res, 200, { ok: true, service: 'marketplace-api', db: 'ok', runtime: 'postgresql' }, headers);
      }
      const publicAuthRoutes = {
        'POST /api/v1/auth/register': async body => ({ status: 201, body: await authRepository.registerCustomer(body) }),
        'POST /api/v1/auth/register-seller': async body => ({ status: 201, body: await authRepository.registerSeller(body) }),
        'POST /api/v1/auth/login': async body => ({ status: 200, body: await authRepository.login(body) }),
        'POST /api/v1/auth/forgot-password': async body => ({ status: 200, body: { data: await authRepository.forgotPassword(body) } }),
        'POST /api/v1/auth/reset-password': async body => ({ status: 200, body: { data: await authRepository.resetPassword(body) } })
      };
      const protectedAuthRoutes = {
        'POST /api/v1/auth/logout': async user => ({ data: await authRepository.logout(user) }),
        'GET /api/v1/auth/me': async user => ({ data: await authRepository.getMe(user) }),
        'PATCH /api/v1/me': async (user, body) => ({ data: await authRepository.updateProfile(user, body) }),
        'POST /api/v1/auth/change-password': async (user, body) => ({ data: await authRepository.changePassword(user, body) }),
        'POST /api/v1/auth/send-verification': async (user, body) => ({ data: await authRepository.sendVerification(user, body) }),
        'POST /api/v1/auth/verify': async (user, body) => ({ data: await authRepository.verify(user, body) }),
        'GET /api/v1/notifications': async user => ({ data: await authRepository.listNotifications(user.id) }),
        'POST /api/v1/notifications/read': async user => ({ data: await authRepository.markNotificationsRead(user.id) })
      };
      const routeKey = method + ' ' + path, publicHandler = publicAuthRoutes[routeKey], protectedHandler = protectedAuthRoutes[routeKey];
      if (publicHandler || protectedHandler) {
        let user = null;
        if (protectedHandler) {
          const token = bearerToken(req);
          if (!token) return json(res, 401, { error: 'Authentication required' }, headers);
          user = await authRepository.getSessionUser(token);
          if (!user) return json(res, 401, { error: 'Authentication required' }, headers);
        }
        const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req) : {};
        const result = publicHandler ? await publicHandler(body) : await protectedHandler(user, body);
        return json(res, result.status || 200, result.body || result, headers);
      }

      const addressMatch = path.match(/^\/api\/v1\/customer\/addresses(?:\/([^/]+))?$/);
      const wishlistMatch = path.match(/^\/api\/v1\/customer\/wishlist(?:\/([^/]+))?$/);
      const reviewMatch = path.match(/^\/api\/v1\/customer\/products\/([^/]+)\/reviews$/);
      if (addressMatch || wishlistMatch || reviewMatch) {
        const addressId = addressMatch?.[1] ? decodePathPart(addressMatch[1]) : null;
        const productId = reviewMatch?.[1] ? decodePathPart(reviewMatch[1]) : null;
        const wishlistProductId = wishlistMatch?.[1] ? decodePathPart(wishlistMatch[1]) : null;
        const supported = addressMatch
          ? (method === 'GET' && !addressId) || (method === 'POST' && !addressId) || (method === 'PUT' && !!addressId) || (method === 'DELETE' && !!addressId)
          : wishlistMatch
            ? (method === 'GET' && !wishlistProductId) || (method === 'POST' && !wishlistProductId) || (method === 'DELETE' && !!wishlistProductId)
            : method === 'POST';
        if (!supported) return json(res, 405, { error: 'Method not allowed' }, headers);
        const token = bearerToken(req);
        if (!token) return json(res, 401, { error: 'Authentication required' }, headers);
        const user = await authRepository.getSessionUser(token);
        if (!user) return json(res, 401, { error: 'Authentication required' }, headers);
        if (user.role !== 'CUSTOMER') return json(res, 403, { error: 'এই অপারেশন শুধু গ্রাহকের জন্য' }, headers);
        const body = ['POST', 'PUT'].includes(method) ? await readJsonBody(req) : {};
        if (addressMatch) {
          if (method === 'GET') return json(res, 200, { data: await customerRepository.listAddresses(user.id) }, headers);
          if (method === 'POST') return json(res, 201, { data: await customerRepository.createAddress({ user, body }) }, headers);
          if (method === 'PUT') return json(res, 200, { data: await customerRepository.updateAddress({ user, addressId, body }) }, headers);
          return json(res, 200, { data: await customerRepository.deleteAddress(user.id, addressId) }, headers);
        }
        if (wishlistMatch) {
          if (method === 'GET') return json(res, 200, { data: await customerRepository.listWishlist(user.id) }, headers);
          if (method === 'POST') return json(res, 201, { data: await customerRepository.addWishlist(user.id, body.productId) }, headers);
          return json(res, 200, { data: await customerRepository.removeWishlist(user.id, wishlistProductId) }, headers);
        }
        return json(res, 201, { data: await customerRepository.saveReview({ userId: user.id, productId, body }) }, headers);
      }

      if (path.startsWith('/api/v1/seller/inventory') || path.startsWith('/api/v1/admin/inventory')) {
        const token = bearerToken(req);
        if (!token) return json(res, 401, { error: 'Authentication required' }, headers);
        const user = await authRepository.getSessionUser(token);
        if (!user) return json(res, 401, { error: 'Authentication required' }, headers);
        const body = method === 'POST' ? await readJsonBody(req) : {};
        const result = await handlePostgresInventoryWorkspace({ database, user, method, path, url, body });
        if (result) return json(res, result.status || 200, result, headers);
      }

      const domainMatch = domainRoutes.map(route => ({ route, match: path.match(route.re) })).find(item => item.match);
      if (domainMatch) {
        const { route, match } = domainMatch;
        if (method !== route.method) return json(res, 405, { error: 'Method not allowed' }, headers);
        let user = null;
        if (route.roles) {
          const token = bearerToken(req);
          if (!token) return json(res, 401, { error: 'Authentication required' }, headers);
          user = await authRepository.getSessionUser(token);
          if (!user) return json(res, 401, { error: 'Authentication required' }, headers);
          if (!route.roles.includes(user.role)) return json(res, 403, { error: 'You do not have permission for this action' }, headers);
        }
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readJsonBody(req) : {};
        const params = match.slice(1).map(decodePathPart);
        const result = await route.handler({ req, res, url, params, body, user, ip });
        return json(res, result.status || 200, result.body || result, headers);
      }

      const knownPath = path === '/health' ||
        ['/api/v1/categories', '/api/v1/brands', '/api/v1/products', '/api/v1/products/suggest',
          '/api/v1/auth/register', '/api/v1/auth/register-seller', '/api/v1/auth/login',
          '/api/v1/auth/logout', '/api/v1/auth/me', '/api/v1/auth/forgot-password',
          '/api/v1/auth/reset-password', '/api/v1/auth/change-password',
          '/api/v1/auth/send-verification', '/api/v1/auth/verify',
          '/api/v1/notifications', '/api/v1/notifications/read', '/api/v1/me'].includes(path) ||
        /^\/api\/v1\/products\/[^/]+(?:\/reviews)?$/.test(path);
      return json(res, knownPath ? 405 : 404, { error: knownPath ? 'Method not allowed' : 'Not found' }, headers);
    } catch (error) { return routeError(error, res, headers); }
  });
}

export async function createPostgresApi({
  env = process.env, createPool = options => createPostgresPool(options),
  verifyConnection = verifyPostgresConnection, migrate = runPostgresMigrations,
  createServer = createPostgresApiServer
} = {}) {
  // Customer accounts are now mounted, but seller/admin workspaces, commerce,
  // payment and delivery routes remain incomplete. Keep production fail-closed.
  if (env.NODE_ENV === 'production') {
    throw new Error('PostgreSQL API is incomplete; production startup remains blocked until seller, admin, commerce, payment and delivery routes are integrated and verified');
  }
  postgresPoolOptions(env);
  const pool = await createPool({ env });
  try {
    const connection = await verifyConnection(pool);
    const migrationResult = env.PG_AUTO_MIGRATE === '0' ? null : await migrate(pool, migrationDirectory);
    const database = createPostgresDatabase(pool);
    const catalogRepository = createPostgresCatalogRepository(database);
    const authRepository = createPostgresAuthRepository(database);
    const customerRepository = createPostgresCustomerRepository(database);
    const server = createServer({ database, catalogRepository, authRepository, customerRepository, env });
    return { pool, server, connection, migrationResult };
  } catch (error) {
    await closePostgresPool(pool);
    throw error;
  }
}

export async function startPostgresApi({ env = process.env, ...options } = {}) {
  const app = await createPostgresApi({ env, ...options });
  const port = Number(env.PORT || 3000), host = env.HOST || '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    await closePostgresPool(app.pool);
    throw new TypeError('PORT must be an integer between 1 and 65535');
  }
  try {
    await new Promise((resolveListen, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, host, resolveListen);
    });
  } catch (error) { await closePostgresPool(app.pool); throw error; }
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
