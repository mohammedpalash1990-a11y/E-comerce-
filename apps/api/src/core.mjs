import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
export const prod = env.NODE_ENV === 'production';
export const config = {
  port: Number(env.PORT || 4000), prod,
  corsOrigins: (env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:4000').split(',').map(s => s.trim()).filter(Boolean),
  sessionDays: Number(env.SESSION_DAYS || 7),
  authMax: Number(env.RATE_LIMIT_AUTH_MAX || 20), generalMax: Number(env.RATE_LIMIT_MAX || 600),
  paymentMode: env.PAYMENT_MODE || 'sandbox', courierMode: env.COURIER_MODE || 'sandbox',
  webhookSecret: env.PAYMENT_WEBHOOK_SECRET || (prod ? '' : 'dev-sandbox-secret'),
  freeShippingPaisa: Number(env.FREE_SHIPPING_OVER_BDT || 0) * 100,
  exposeDevCodes: !prod
};
if (prod && !config.webhookSecret) throw new Error('PAYMENT_WEBHOOK_SECRET is required in production');
if (prod) {
  if (env.DATABASE_URL) throw new Error('PostgreSQL runtime adapter is not implemented; production startup is blocked');
  throw new Error('Production startup is blocked: current API runtime uses SQLite. Use development/staging only until PostgreSQL runtime and migrations are implemented');
}


export class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
export const bad = m => new HttpError(400, m);
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const sha256 = s => createHash('sha256').update(String(s)).digest('hex');
export const hmac = (secret, s) => createHmac('sha256', secret).update(s).digest('hex');
export const hashPassword = pw => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(pw, salt, 64).toString('hex'); };
const DUMMY = hashPassword('dummy-password-for-timing');
export function verifyPassword(pw, stored) {
  const [salt, key] = (stored || DUMMY).split(':');
  const actual = scryptSync(String(pw || ''), salt, 64), expected = Buffer.from(key, 'hex');
  return stored && actual.length === expected.length && timingSafeEqual(actual, expected);
}
export const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
export const normPhone = p => String(p || '').replace(/[\s-]/g, '').replace(/^\+?88/, '');
export const validPhone = p => /^01[3-9]\d{8}$/.test(p);
export const validEmail = e => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e) && e.length <= 160;
export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw bad('পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে এবং অক্ষর ও সংখ্যা থাকতে হবে');
}
export function text(v, max, label, { required = true } = {}) {
  const s = String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !s) throw bad(label + ' দিতে হবে');
  if (s.length > max) throw bad(label + ' অনেক লম্বা');
  return s;
}
export function money(v, label) { const n = Number(v); const p = Math.round(n * 100); if (!Number.isFinite(n) || n <= 0 || !Number.isSafeInteger(p) || p > 1e11) throw bad(label + ' সঠিক নয়'); return p; }

// ---- database ----
const file = env.SQLITE_FILE === ':memory:' ? ':memory:' : resolve(env.SQLITE_FILE || 'data/marketplace.sqlite');
if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
export const q = sql => db.prepare(sql);
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const cols = t => db.prepare('PRAGMA table_info(' + t + ')').all().map(r => r.name);
const legacy = {
  users: { email: 'TEXT', status: "TEXT NOT NULL DEFAULT 'ACTIVE'", phone_verified: 'INTEGER NOT NULL DEFAULT 0', email_verified: 'INTEGER NOT NULL DEFAULT 0', created_at: "TEXT NOT NULL DEFAULT ''" },
  categories: { name_en: "TEXT NOT NULL DEFAULT ''" },
  products: { seller_id: 'TEXT', status: "TEXT NOT NULL DEFAULT 'ACTIVE'", brand_id: 'TEXT', description: "TEXT NOT NULL DEFAULT ''", discount_paisa: 'INTEGER', sku: 'TEXT', variants: "TEXT NOT NULL DEFAULT '[]'", created_at: "TEXT NOT NULL DEFAULT ''", updated_at: "TEXT NOT NULL DEFAULT ''" },
  orders: { delivery_name: "TEXT NOT NULL DEFAULT ''", delivery_phone: "TEXT NOT NULL DEFAULT ''", delivery_address: "TEXT NOT NULL DEFAULT ''", delivery_area: "TEXT NOT NULL DEFAULT ''", customer_note: "TEXT NOT NULL DEFAULT ''", subtotal_paisa: 'INTEGER NOT NULL DEFAULT 0', shipping_paisa: 'INTEGER NOT NULL DEFAULT 0', discount_paisa: 'INTEGER NOT NULL DEFAULT 0', coupon_code: 'TEXT', payment_method: "TEXT NOT NULL DEFAULT 'COD'", payment_status: "TEXT NOT NULL DEFAULT 'PENDING'", admin_note: "TEXT NOT NULL DEFAULT ''" },
  seller_orders: { commission_paisa: 'INTEGER NOT NULL DEFAULT 0', net_paisa: 'INTEGER NOT NULL DEFAULT 0' },
  order_items: { seller_id: 'TEXT', seller_order_id: 'TEXT', variant: "TEXT NOT NULL DEFAULT ''" }
};
export function migrate() {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations/sqlite');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const f of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    if (q('SELECT 1 FROM schema_migrations WHERE name=?').get(f)) continue;
    db.exec(readFileSync(resolve(dir, f), 'utf8'));
    if (f.startsWith('001')) for (const [t, defs] of Object.entries(legacy)) { // upgrade old demo databases
      const have = cols(t); for (const [c, d] of Object.entries(defs)) if (!have.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
    }
    q('INSERT INTO schema_migrations VALUES(?,?)').run(f, now());
  }
}
migrate();

export function audit(actorId, action, entity, entityId, detail = {}) {
  q('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?)').run(id(), actorId || null, action, entity, entityId || null, JSON.stringify(detail), now());
}
export function notify(userId, title, body = '') {
  if (userId) q('INSERT INTO notifications VALUES(?,?,?,?,0,?)').run(id(), userId, title, body, now());
}
export const orderNo = oid => 'BD-' + oid.slice(0, 8).toUpperCase();
export const bdt = p => p / 100;
export const slugify = s => String(s).toLowerCase().trim().replace(/[^a-z0-9\u0980-\u09ff]+/g, '-').replace(/^-|-$/g, '') || randomBytes(3).toString('hex');
