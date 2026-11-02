import { randomBytes, randomInt } from 'node:crypto';
import {
  config,
  id,
  now,
  sha256,
  hashPassword,
  verifyPassword,
  safeEq,
  normPhone,
  validPhone,
  validEmail,
  checkPassword,
  text,
  bad,
  HttpError
} from './postgres-shared.mjs';

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    phone: u.phone,
    email: u.email || null,
    phone_verified: !!Number(u.phone_verified),
    email_verified: !!Number(u.email_verified)
  };
}

export function createPostgresAuthRepository(database, overrides = {}) {
  if (!database || typeof database.q !== 'function' || typeof database.tx !== 'function') {
    throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  }

  const query = sql => database.q(sql);
  const transaction = fn => database.tx(fn);
  const generateId = overrides.id || id;
  const getNow = overrides.now || now;
  const hash = overrides.sha256 || sha256;
  const hashPw = overrides.hashPassword || hashPassword;
  const verifyPw = overrides.verifyPassword || verifyPassword;
  const generateRandomBytes = overrides.randomBytes || randomBytes;
  const generateRandomInt = overrides.randomInt || randomInt;

  async function createSession(userId) {
    const token = generateRandomBytes(32).toString('hex');
    const tokenHash = hash(token);
    const expiresAt = new Date(Date.now() + config.sessionDays * 864e5).toISOString();
    await query('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES(?, ?, ?, ?)')
      .run(tokenHash, userId, expiresAt, getNow());
    return token;
  }

  async function getSessionUser(token) {
    if (!token) return null;
    const tokenHash = hash(token);
    const s = await query('SELECT user_id, expires_at FROM sessions WHERE token_hash=?').get(tokenHash);
    if (!s || s.expires_at < getNow()) return null;
    const u = await query('SELECT id, name, phone, email, role, status, phone_verified, email_verified FROM users WHERE id=?')
      .get(s.user_id);
    return u && u.status === 'ACTIVE' ? { ...u, token_hash: tokenHash } : null;
  }

  async function cleanupExpiredSessions() {
    return query('DELETE FROM sessions WHERE expires_at<?').run(getNow());
  }

  async function revokeSession(tokenHash) {
    if (!tokenHash) return;
    return query('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);
  }

  async function revokeUserSessions(userId, exceptTokenHash = null) {
    if (exceptTokenHash) {
      return query('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId, exceptTokenHash);
    }
    return query('DELETE FROM sessions WHERE user_id=?').run(userId);
  }

  async function issueOtp(userId, purpose) {
    const code = String(generateRandomInt(100000, 1000000));
    const timestamp = getNow();
    await query('UPDATE otp_codes SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL')
      .run(timestamp, userId, purpose);
    const codeHash = hash(code + userId);
    const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    await query('INSERT INTO otp_codes(id, user_id, purpose, code_hash, attempts, expires_at, used_at, created_at) VALUES(?, ?, ?, ?, 0, ?, NULL, ?)')
      .run(generateId(), userId, purpose, codeHash, expiresAt, timestamp);
    return code;
  }

  // Must be called inside a transaction. The row lock serializes all attempts
  // against the current OTP, including simultaneous valid-code submissions.
  async function consumeOtp(userId, purpose, code) {
    const row = await query('SELECT * FROM otp_codes WHERE user_id=? AND purpose=? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE')
      .get(userId, purpose);
    if (!row || row.expires_at < getNow() || Number(row.attempts) >= 5) {
      return bad('কোড মেয়াদোত্তীর্ণ বা অবৈধ');
    }

    // The row lock makes this read/check/increment sequence atomic across
    // PostgreSQL transactions; attempts can never advance beyond five.
    await query('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
    if (!safeEq(hash(String(code || '') + userId), row.code_hash)) {
      return bad('কোড সঠিক নয়');
    }
    await query('UPDATE otp_codes SET used_at=? WHERE id=? AND used_at IS NULL').run(getNow(), row.id);
    return null;
  }

  async function checkOtp(userId, purpose, code) {
    // Return the validation error from the transaction and throw only after
    // it commits, so a failed attempt is not rolled back with the exception.
    const error = await transaction(() => consumeOtp(userId, purpose, code));
    if (error) throw error;
  }

  async function findByIdentifier(identifier) {
    const v = String(identifier || '').trim();
    return v.includes('@')
      ? query('SELECT * FROM users WHERE lower(email)=lower(?)').get(v)
      : query('SELECT * FROM users WHERE phone=?').get(normPhone(v));
  }

  async function auditLog(actorId, action, entity, entityId, detail = {}) {
    await query('INSERT INTO audit_logs(id, actor_id, action, entity, entity_id, detail, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(generateId(), actorId || null, action, entity, entityId || null, JSON.stringify(detail), getNow());
  }

  async function sendNotification(userId, title, body = '') {
    if (!userId) return;
    await query('INSERT INTO notifications(id, user_id, title, body, read, created_at) VALUES(?, ?, ?, ?, 0, ?)')
      .run(generateId(), userId, title, body, getNow());
  }

  async function baseRegister(b, role) {
    const name = text(b.name, 100, 'নাম');
    const phone = normPhone(b.phone);
    const email = text(b.email, 160, 'ইমেইল', { required: role === 'SELLER' }).toLowerCase();
    if (!validPhone(phone)) throw bad('সঠিক বাংলাদেশি মোবাইল নম্বর দিন');
    if (email && !validEmail(email)) throw bad('সঠিক ইমেইল দিন');
    checkPassword(b.password);
    if (b.confirm_password !== undefined && b.confirm_password !== b.password) {
      throw bad('পাসওয়ার্ড মিলছে না');
    }

    const existingPhone = await query('SELECT 1 FROM users WHERE phone=?').get(phone);
    if (existingPhone) throw new HttpError(409, 'এই মোবাইল নম্বর দিয়ে আগেই অ্যাকাউন্ট আছে');

    if (email) {
      const existingEmail = await query('SELECT 1 FROM users WHERE lower(email)=?').get(email);
      if (existingEmail) throw new HttpError(409, 'এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট আছে');
    }

    const uid = generateId();
    await query('INSERT INTO users(id, phone, email, name, password, role, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid, phone, email || null, name, hashPw(b.password), role, 'ACTIVE', getNow());
    return { uid, name, phone, email };
  }

  async function registerCustomer(body) {
    return transaction(async () => {
      const u = await baseRegister(body, 'CUSTOMER');
      const addr = text(body.address, 500, 'ঠিকানা', { required: false });
      if (addr) {
        await query('INSERT INTO addresses(id, user_id, label, name, phone, address, area, is_default) VALUES(?, ?, ?, ?, ?, ?, ?, 1)')
          .run(generateId(), u.uid, 'Home', u.name, u.phone, addr, text(body.area, 100, 'এলাকা', { required: false }) || '—');
      }
      await auditLog(u.uid, 'CUSTOMER_REGISTER', 'user', u.uid);
      const token = await createSession(u.uid);
      const out = { token, data: { id: u.uid, name: u.name, role: 'CUSTOMER', phone: u.phone } };
      if (config.exposeDevCodes) {
        out.dev_verification_code = await issueOtp(u.uid, 'PHONE');
      }
      return out;
    });
  }

  async function registerSeller(body) {
    const shop = text(body.shop_name, 100, 'দোকানের নাম');
    const shopAddr = text(body.shop_address, 300, 'দোকানের ঠিকানা');
    const biz = text(body.business_info, 1000, 'ব্যবসার তথ্য');
    const nid = text(body.kyc_nid, 30, 'NID নম্বর');
    if (!/^\d{10,17}$/.test(nid)) throw bad('সঠিক NID নম্বর দিন');

    return transaction(async () => {
      const existingShop = await query('SELECT 1 FROM seller_profiles WHERE lower(shop_name)=lower(?)').get(shop);
      if (existingShop) throw new HttpError(409, 'এই দোকানের নাম আগেই নেওয়া হয়েছে');

      const u = await baseRegister(body, 'SELLER');
      await query('INSERT INTO seller_profiles(user_id, shop_name, shop_address, business_info, kyc_nid, kyc_trade_license, status, commission_bps, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(u.uid, shop, shopAddr, biz, nid, text(body.kyc_trade_license, 60, 'ট্রেড লাইসেন্স', { required: false }), 'PENDING', 800, getNow());
      await auditLog(u.uid, 'SELLER_REGISTER', 'seller', u.uid, { shop });

      const admins = await query("SELECT id FROM users WHERE role='ADMIN'").all();
      for (const a of admins) {
        await sendNotification(a.id, 'নতুন বিক্রেতা আবেদন', shop);
      }

      const token = await createSession(u.uid);
      return {
        token,
        data: {
          id: u.uid,
          name: u.name,
          role: 'SELLER',
          status: 'PENDING',
          message: 'অ্যাডমিন অনুমোদনের আগে পণ্য পাবলিক স্টোরফ্রন্টে দেখা যাবে না'
        }
      };
    });
  }

  async function login(body) {
    const user = await findByIdentifier(body.identifier ?? body.phone);
    const good = verifyPw(body.password, user && user.password);
    if (!user || !good) throw new HttpError(401, 'Invalid phone or password');
    if (body.portal && String(body.portal).toUpperCase() !== user.role) {
      throw new HttpError(403, 'এই পোর্টালে লগইন অনুমোদিত নয়');
    }
    if (user.status !== 'ACTIVE') {
      throw new HttpError(403, 'আপনার অ্যাকাউন্ট সাময়িকভাবে বন্ধ আছে');
    }
    await auditLog(user.id, 'LOGIN', 'user', user.id);
    const token = await createSession(user.id);
    return { token, data: publicUser(user) };
  }

  async function logout(user) {
    if (user?.token_hash) {
      await revokeSession(user.token_hash);
    }
    return { loggedOut: true };
  }

  async function getMe(user) {
    let sp = null;
    if (user.role === 'SELLER') {
      sp = await query('SELECT shop_name, status FROM seller_profiles WHERE user_id=?').get(user.id);
    }
    return { ...publicUser(user), seller: sp || null };
  }

  async function updateProfile(user, body) {
    const name = body.name !== undefined ? text(body.name, 100, 'নাম') : user.name;
    let { phone, email } = user;
    if (body.phone !== undefined) {
      phone = normPhone(body.phone);
      if (!validPhone(phone)) throw bad('সঠিক মোবাইল নম্বর দিন');
    }
    if (body.email !== undefined) {
      email = text(body.email, 160, 'ইমেইল', { required: false }).toLowerCase() || null;
      if (email && !validEmail(email)) throw bad('সঠিক ইমেইল দিন');
    }
    if (phone !== user.phone) {
      const exists = await query('SELECT 1 FROM users WHERE phone=? AND id<>?').get(phone, user.id);
      if (exists) throw new HttpError(409, 'এই মোবাইল নম্বর ব্যবহৃত');
    }
    if (email && email !== user.email) {
      const exists = await query('SELECT 1 FROM users WHERE lower(email)=? AND id<>?').get(email, user.id);
      if (exists) throw new HttpError(409, 'এই ইমেইল ব্যবহৃত');
    }

    const phoneVerified = phone === user.phone ? user.phone_verified : 0;
    const emailVerified = email === user.email ? user.email_verified : 0;
    await query('UPDATE users SET name=?, phone=?, email=?, phone_verified=?, email_verified=? WHERE id=?')
      .run(name, phone, email, phoneVerified, emailVerified, user.id);
    const updated = await query('SELECT * FROM users WHERE id=?').get(user.id);
    return publicUser(updated);
  }

  async function changePassword(user, body) {
    const row = await query('SELECT password FROM users WHERE id=?').get(user.id);
    if (!verifyPw(body.current_password, row?.password)) {
      throw new HttpError(403, 'বর্তমান পাসওয়ার্ড সঠিক নয়');
    }
    checkPassword(body.new_password);
    await transaction(async () => {
      await query('UPDATE users SET password=? WHERE id=?').run(hashPw(body.new_password), user.id);
      await revokeUserSessions(user.id, user.token_hash);
      await auditLog(user.id, 'PASSWORD_CHANGE', 'user', user.id);
    });
    return { changed: true };
  }

  async function forgotPassword(body) {
    const u = await findByIdentifier(body.identifier);
    const out = { message: 'যদি অ্যাকাউন্টটি থাকে, একটি রিসেট কোড পাঠানো হয়েছে' };
    if (u && u.status === 'ACTIVE') {
      const code = await issueOtp(u.id, 'RESET');
      if (config.exposeDevCodes) out.dev_code = code;
    }
    return out;
  }

  async function resetPassword(body) {
    const u = await findByIdentifier(body.identifier);
    if (!u) throw bad('কোড মেয়াদোত্তীর্ণ বা অবৈধ');
    checkPassword(body.new_password);
    const otpError = await transaction(async () => {
      const error = await consumeOtp(u.id, 'RESET', body.code);
      if (error) return error;
      await query('UPDATE users SET password=? WHERE id=?').run(hashPw(body.new_password), u.id);
      await revokeUserSessions(u.id);
      await auditLog(u.id, 'PASSWORD_RESET', 'user', u.id);
      return null;
    });
    if (otpError) throw otpError;
    return { reset: true };
  }

  async function sendVerification(user, body) {
    const purpose = body.purpose === 'EMAIL' ? 'EMAIL' : 'PHONE';
    if (purpose === 'EMAIL' && !user.email) throw bad('আগে ইমেইল যোগ করুন');
    const code = await issueOtp(user.id, purpose);
    return { sent: true, ...(config.exposeDevCodes ? { dev_code: code } : {}) };
  }

  async function verify(user, body) {
    const purpose = body.purpose === 'EMAIL' ? 'EMAIL' : 'PHONE';
    const otpError = await transaction(async () => {
      const error = await consumeOtp(user.id, purpose, body.code);
      if (error) return error;
      const col = purpose === 'EMAIL' ? 'email_verified' : 'phone_verified';
      await query(`UPDATE users SET ${col}=1 WHERE id=?`).run(user.id);
      return null;
    });
    if (otpError) throw otpError;
    return { verified: purpose };
  }

  async function listNotifications(userId) {
    return query('SELECT id, title, body, read, created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50')
      .all(userId);
  }

  async function markNotificationsRead(userId) {
    await query('UPDATE notifications SET read=1 WHERE user_id=?').run(userId);
    return { read: true };
  }

  return Object.freeze({
    createSession,
    getSessionUser,
    cleanupExpiredSessions,
    revokeSession,
    revokeUserSessions,
    issueOtp,
    checkOtp,
    findByIdentifier,
    registerCustomer,
    registerSeller,
    login,
    logout,
    getMe,
    updateProfile,
    changePassword,
    forgotPassword,
    resetPassword,
    sendVerification,
    verify,
    listNotifications,
    markNotificationsRead
  });
}
