import { id, now, bad, HttpError } from './postgres-shared.mjs';
import { normalizeCouponCode, expiryTime } from './postgres-coupons.mjs';
import { parseSafePostgresBigInt } from './postgres-types.mjs';

function allowedFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    throw bad('Unsupported coupon fields');
  }
}
function integer(value, minimum, maximum, label) {
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value).trim())) throw bad('Invalid ' + label);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw bad('Invalid ' + label);
  return result;
}
function paisa(value, positive, label) {
  if (!['number', 'string'].includes(typeof value)) throw bad('Invalid ' + label);
  const match = String(value).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw bad(label + ' must have at most two decimal places');
  const amount = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < (positive ? 1n : 0n)) throw bad('Invalid ' + label);
  return Number(amount);
}
function boolean(value) {
  if (typeof value !== 'boolean') throw bad('active must be a JSON boolean');
  return value;
}
function requiredCode(value) {
  const code = normalizeCouponCode(value);
  if (code === null) throw bad('Coupon code is required');
  return code;
}
function clock(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Invalid coupon administration clock');
  return time;
}
function canActivate(coupon, current) {
  try {
    const amount = parseSafePostgresBigInt(coupon.value), minimum = parseSafePostgresBigInt(coupon.min_order_paisa);
    const used = parseSafePostgresBigInt(coupon.used_count);
    const maximum = coupon.max_uses === null ? null : parseSafePostgresBigInt(coupon.max_uses);
    const expiry = expiryTime(coupon.expires_at);
    if (!['FIXED', 'PERCENT'].includes(coupon.type) || amount < 1 || minimum < 0 ||
        (coupon.type === 'PERCENT' && amount > 90) || used < 0 || used >= Number.MAX_SAFE_INTEGER ||
        (maximum !== null && (maximum < 1 || used >= maximum)) || (expiry !== null && expiry <= current)) throw new Error();
  } catch { throw new HttpError(409, 'Cannot activate an expired, exhausted or invalid coupon'); }
}
const view = row => {
  const value = parseSafePostgresBigInt(row.value), minimum = parseSafePostgresBigInt(row.min_order_paisa);
  return {
    code: row.code, type: row.type, value, min_order_paisa: minimum,
    max_uses: row.max_uses === null ? null : parseSafePostgresBigInt(row.max_uses),
    max_uses_per_customer: row.max_uses_per_customer == null ? null : parseSafePostgresBigInt(row.max_uses_per_customer),
    used_count: parseSafePostgresBigInt(row.used_count), expires_at: row.expires_at,
    active: parseSafePostgresBigInt(row.active),
    value_bdt: row.type === 'FIXED' ? value / 100 : null, min_order_bdt: minimum / 100
  };
};

// Preserves the existing SQLite/older PR #19 coupon API and audit action names,
// with bounded reads and atomic audited writes in the isolated PostgreSQL API.
export function registerPostgresAdminCouponRoutes(route, ok, { database, id: makeId = id, now: getNow = now } = {}) {
  if (!database?.q || !database?.tx) throw new TypeError('PostgreSQL database with transactions is required');
  const q = sql => database.q(sql);
  const lockAdmin = async user => {
    const admin = await q("SELECT id FROM users WHERE id=? AND role='ADMIN' AND status='ACTIVE' FOR SHARE").get(user.id);
    if (!admin) throw new HttpError(403, 'Active administrator required');
  };
  const audit = (actorId, action, code, detail, timestamp) =>
    q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(makeId(), actorId, action, 'coupon', code, JSON.stringify(detail), timestamp);

  route('GET', '/api/v1/admin/coupons', ['ADMIN'], async ({ url }) => {
    const params = url.searchParams;
    for (const key of ['limit', 'offset', 'active']) if (params.getAll(key).length > 1) throw bad('Duplicate ' + key + ' parameter');
    const limit = params.has('limit') ? integer(params.get('limit'), 1, 300, 'limit') : 100;
    const offset = params.has('offset') ? integer(params.get('offset'), 0, 10000, 'offset') : 0;
    const active = params.has('active') ? integer(params.get('active'), 0, 1, 'active filter') : null;
    const rows = await q(`SELECT code,type,value,min_order_paisa,max_uses,max_uses_per_customer,used_count,expires_at,active
      FROM coupons${active === null ? '' : ' WHERE active=?'} ORDER BY code LIMIT ? OFFSET ?`)
      .all(...(active === null ? [limit, offset] : [active, limit, offset]));
    return ok(rows.map(view));
  });

  route('POST', '/api/v1/admin/coupons', ['ADMIN'], async ({ user, body }) => {
    allowedFields(body, ['code', 'type', 'value', 'min_order_bdt', 'max_uses', 'max_uses_per_customer', 'expires_at', 'active']);
    const code = requiredCode(body.code);
    if (!['FIXED', 'PERCENT'].includes(body.type)) throw bad('type must be FIXED or PERCENT');
    const type = body.type;
    const value = type === 'FIXED' ? paisa(body.value, true, 'discount BDT') : integer(body.value, 1, 90, 'percentage');
    const minimum = paisa(body.min_order_bdt === undefined || body.min_order_bdt === '' ? 0 : body.min_order_bdt, false, 'minimum order BDT');
    const maxUses = body.max_uses === undefined || body.max_uses === null || body.max_uses === '' ? null : integer(body.max_uses, 1, Number.MAX_SAFE_INTEGER, 'maximum uses');
    const maxUsesPerCustomer = body.max_uses_per_customer === undefined || body.max_uses_per_customer === null || body.max_uses_per_customer === '' ? null : integer(body.max_uses_per_customer, 1, Number.MAX_SAFE_INTEGER, 'maximum uses per customer');
    const expires = body.expires_at === undefined || body.expires_at === null || body.expires_at === '' ? null : expiryTime(body.expires_at);
    const active = body.active === undefined ? true : boolean(body.active);
    return database.tx(async () => {
      await lockAdmin(user);
      const timestamp = getNow();
      if (expires !== null && expires <= clock(timestamp)) throw bad('Coupon expiry must be in the future');
      const expiry = expires === null ? null : new Date(expires).toISOString();
      await q('INSERT INTO coupons(code,type,value,min_order_paisa,max_uses,max_uses_per_customer,used_count,expires_at,active) VALUES(?,?,?,?,?,?,0,?,?)')
        .run(code, type, value, minimum, maxUses, maxUsesPerCustomer, expiry, active ? 1 : 0);
      await audit(user.id, 'COUPON_CREATE', code, { type, value, min_order_paisa: minimum, max_uses: maxUses, max_uses_per_customer: maxUsesPerCustomer, expires_at: expiry, active }, timestamp);
      return ok({ code }, 201);
    });
  });

  route('PATCH', '/api/v1/admin/coupons/:code', ['ADMIN'], async ({ user, params, body }) => {
    allowedFields(body, ['active']);
    const code = requiredCode(params[0]), active = boolean(body.active);
    return database.tx(async () => {
      await lockAdmin(user);
      // Same row lock as checkout redemption: disabling cannot race past a
      // pending use and toggling never overwrites/reset usage or monetary terms.
      const coupon = await q('SELECT code,type,value,min_order_paisa,max_uses,max_uses_per_customer,used_count,expires_at,active FROM coupons WHERE code=? FOR UPDATE').get(code);
      if (!coupon) throw new HttpError(404, 'Coupon not found');
      const timestamp = getNow();
      if (active) canActivate(coupon, clock(timestamp));
      const fromActive = Number(coupon.active);
      if (fromActive === Number(active)) return ok({ code, active });
      await q('UPDATE coupons SET active=? WHERE code=?').run(active ? 1 : 0, code);
      await audit(user.id, 'COUPON_TOGGLE', code, { from_active: fromActive, active, used_count: parseSafePostgresBigInt(coupon.used_count) }, timestamp);
      return ok({ code, active });
    });
  });
}
