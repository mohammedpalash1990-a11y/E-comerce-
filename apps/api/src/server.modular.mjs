import http from 'node:http';
import { config, q, db, now, sha256, HttpError } from './core.mjs';
import registerPublic from './routes_public.mjs';
import registerCustomer from './routes_customer.mjs';
import registerSeller from './routes_seller.mjs';
import registerAdmin from './routes_admin.mjs';
import registerPayments from './routes_payments.mjs';
import './seed.mjs';

const routes = [];
// roles: null = public, 'AUTH' = any logged-in user, or array of roles
function route(method, pattern, roles, handler, opts = {}) {
  const re = new RegExp('^' + pattern.replace(/:id/g, '([0-9a-fA-F-]{36})').replace(/:(\w+)/g, '([^/]+)') + '$');
  routes.push({ method, re, roles, handler, limit: opts.limit || 200000 });
}
export const ok = (data, status = 200) => ({ status, body: { data } });
registerPublic(route, ok); registerCustomer(route, ok); registerSeller(route, ok); registerAdmin(route, ok); registerPayments(route, ok);

const hits = new Map();
function allow(key, max, windowMs) {
  const t = Date.now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(t); hits.set(key, arr); return true;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some(x => t - x < 900000)) hits.delete(k); }, 60000).unref();
setInterval(() => { try { q('DELETE FROM sessions WHERE expires_at<?').run(now()); } catch {} }, 600000).unref();

function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
async function readBody(req, limit) {
  const chunks = []; let size = 0;
  let tooBig = false;
  for await (const c of req) { size += c.length; if (size > limit) { tooBig = true; if (size > limit * 20) req.destroy(); continue; } chunks.push(c); } // drain instead of resetting the socket
  if (tooBig) throw new HttpError(413, 'Payload too large');
  if (!size) return {};
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' ? v : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
}
export function sessionUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const s = q('SELECT user_id,expires_at FROM sessions WHERE token_hash=?').get(sha256(token));
  if (!s || s.expires_at < now()) return null;
  const u = q('SELECT id,name,phone,email,role,status,phone_verified,email_verified FROM users WHERE id=?').get(s.user_id);
  return u && u.status === 'ACTIVE' ? { ...u, token_hash: sha256(token) } : null;
}

export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
  if (config.prod) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  if (origin && config.corsOrigins.includes(origin)) {
    Object.assign(headers, { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' });
  }
  if (req.method === 'OPTIONS') { res.writeHead(origin && headers['access-control-allow-origin'] ? 204 : 403, headers); return res.end(); }
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const ip = (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'x';
    if (!allow('g:' + ip, config.generalMax, 60000)) return send(res, 429, { error: 'অনেক বেশি অনুরোধ, কিছুক্ষণ পরে চেষ্টা করুন' }, headers);
    if (req.method === 'POST' && path.startsWith('/api/v1/auth/') && !allow('a:' + ip, config.authMax, 60000)) return send(res, 429, { error: 'অনেক বেশি চেষ্টা হয়েছে, এক মিনিট পরে আবার চেষ্টা করুন' }, headers);
    let matched = null, pathMismatch = false;
    for (const r of routes) { const m = path.match(r.re); if (m) { if (r.method === req.method) { matched = { r, m }; break; } pathMismatch = true; } }
    if (!matched) return send(res, pathMismatch ? 405 : 404, { error: pathMismatch ? 'Method not allowed' : 'Not found' }, headers);
    const { r, m } = matched;
    let user = null;
    if (r.roles) {
      user = sessionUser(req);
      if (!user) return send(res, 401, { error: 'Authentication required' }, headers);
      if (r.roles !== 'AUTH' && !r.roles.includes(user.role)) return send(res, 403, { error: 'You do not have permission for this action' }, headers);
    }
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req, r.limit) : {};
    const out = await r.handler({ req, res, url, params: m.slice(1), body, user, ip });
    return send(res, out.status || 200, out.body, headers);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) }, headers);
    if (/UNIQUE constraint/.test(e.message || '')) return send(res, 409, { error: 'ডুপ্লিকেট তথ্য পাওয়া গেছে' }, headers);
    console.error('[api error]', e);
    return send(res, 500, { error: 'Internal server error' }, headers);
  }
});
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  server.listen(config.port, '0.0.0.0', () => console.log('API listening on ' + config.port));
}

