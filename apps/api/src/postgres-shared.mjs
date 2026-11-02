import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';

// SQLite-independent helpers shared by PostgreSQL repositories.
const env = process.env;
const production = env.NODE_ENV === 'production';
const webhookSecret = env.PAYMENT_WEBHOOK_SECRET || (production ? '' : 'dev-sandbox-secret');
if (production && !webhookSecret) {
  throw new Error('PAYMENT_WEBHOOK_SECRET is required in production');
}
export const config = Object.freeze({
  sessionDays: Number(env.SESSION_DAYS || 7),
  exposeDevCodes: !production,
  paymentMode: env.PAYMENT_MODE || 'sandbox',
  courierMode: env.COURIER_MODE || 'sandbox',
  webhookSecret,
  freeShippingPaisa: Number(env.FREE_SHIPPING_OVER_BDT || 0) * 100
});

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

export const bad = message => new HttpError(400, message);
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
export const hmac = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');
export const hashPassword = password => {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(String(password), salt, 64).toString('hex');
};

const DUMMY_PASSWORD_HASH = hashPassword('dummy-password-for-timing');
export function verifyPassword(password, stored) {
  const [salt, key] = (stored || DUMMY_PASSWORD_HASH).split(':');
  const actual = scryptSync(String(password || ''), salt, 64);
  const expected = Buffer.from(key, 'hex');
  return Boolean(stored && actual.length === expected.length && timingSafeEqual(actual, expected));
}

export const safeEq = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
export const normPhone = phone => String(phone || '').replace(/[\s-]/g, '').replace(/^\+?88/, '');
export const validPhone = phone => /^01[3-9]\d{8}$/.test(phone);
export const validEmail = email => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) && email.length <= 160;

export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 ||
      !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw bad('পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে এবং অক্ষর ও সংখ্যা থাকতে হবে');
  }
}

export function text(value, max, label, { required = true } = {}) {
  const result = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (required && !result) throw bad(label + ' দিতে হবে');
  if (result.length > max) throw bad(label + ' অনেক লম্বা');
  return result;
}
