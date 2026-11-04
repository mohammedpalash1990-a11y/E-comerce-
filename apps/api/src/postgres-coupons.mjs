import { bad, now as defaultNow } from './postgres-shared.mjs';
import { parseSafePostgresBigInt } from './postgres-types.mjs';

export function normalizeCouponCode(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw bad('Invalid coupon code');
  const code = value.trim().toUpperCase();
  if (!code) return null;
  if (!/^[A-Z0-9_-]{1,30}$/.test(code)) throw bad('Invalid coupon code');
  return code;
}

const unavailable = () => bad('Coupon is invalid, expired or unavailable');
function storedInteger(value, minimum = 0) {
  let result;
  try { result = parseSafePostgresBigInt(value); }
  catch { throw unavailable(); }
  if (result < minimum) throw unavailable();
  return result;
}
function expiryTime(value) {
  if (value === null) return null;
  // Legacy date-only records mean midnight UTC at the START of that date.
  // Timestamp records require an explicit zone; never use the server locale.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(value)) throw unavailable();
  const date = value.slice(0, 10), day = Date.parse(date + 'T00:00:00.000Z');
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) throw unavailable();
  const expiry = Date.parse(value);
  if (!Number.isFinite(expiry)) throw unavailable();
  return expiry;
}

// Adapted from the existing PR #6 validation contract. Preview is read-only;
// checkout must call with lock:true inside its surrounding order transaction.
export function createPostgresCouponRepository(database, { now = defaultNow } = {}) {
  if (!database?.q) throw new TypeError('PostgreSQL database is required');

  async function validateCoupon(value, subtotalPaisa, { lock = false } = {}) {
    const code = normalizeCouponCode(value);
    if (code === null) return null;
    let subtotal;
    try { subtotal = parseSafePostgresBigInt(subtotalPaisa); }
    catch { throw bad('Invalid order subtotal'); }
    if (subtotal < 0) throw bad('Invalid order subtotal');
    const coupon = await database.q(`SELECT code,type,value,min_order_paisa,max_uses,used_count,expires_at,active
      FROM coupons WHERE code=?${lock ? ' FOR UPDATE' : ''}`).get(code);
    if (!coupon || Number(coupon.active) !== 1) throw unavailable();
    const used = storedInteger(coupon.used_count);
    const maximum = coupon.max_uses === null ? null : storedInteger(coupon.max_uses, 1);
    if (used >= Number.MAX_SAFE_INTEGER || (maximum !== null && used >= maximum)) throw unavailable();
    const expiry = expiryTime(coupon.expires_at);
    // Sample the clock AFTER the row lock is acquired: a waiting checkout must
    // not redeem a coupon that expired while another transaction held the lock.
    const current = Date.parse(now());
    if (!Number.isFinite(current)) throw new Error('Invalid coupon validation clock');
    if (expiry !== null && expiry <= current) throw unavailable();
    const minimum = storedInteger(coupon.min_order_paisa);
    if (subtotal < minimum) throw bad('Coupon minimum order amount has not been met');
    const amount = storedInteger(coupon.value, 1);
    if (!['FIXED', 'PERCENT'].includes(coupon.type)) throw unavailable();
    // Preserve the existing admin coupon contract, not a new commission policy.
    if (coupon.type === 'PERCENT' && amount > 90) throw unavailable();
    const discount = coupon.type === 'PERCENT'
      ? Number(BigInt(subtotal) * BigInt(amount) / 100n)
      : Math.min(amount, subtotal);
    return { code: coupon.code, discount };
  }
  return Object.freeze({ validateCoupon });
}
