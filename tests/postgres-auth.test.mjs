import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { hashPassword, sha256 } from '../apps/api/src/core.mjs';

function createMockDatabase() {
  const state = {
    users: new Map(),
    sessions: new Map(),
    otp_codes: new Map(),
    seller_profiles: new Map(),
    addresses: new Map(),
    audit_logs: [],
    notifications: []
  };

  const pool = {
    async query(sql, params = []) {
      const trimmed = sql.trim().replace(/\$\d+/g, '?');

      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/i.test(trimmed)) {
        return { rows: [], rowCount: 0 };
      }

      // INSERT INTO users
      if (/^SELECT id FROM users WHERE id=\\? FOR UPDATE/i.test(trimmed)) {
        const user = state.users.get(params[0]);
        return { rows: user ? [{ id: user.id }] : [], rowCount: user ? 1 : 0 };
      }

      if (/^INSERT INTO users/i.test(trimmed)) {
        const [id, phone, email, name, password, role, status, createdAt] = params;
        state.users.set(id, { id, phone, email, name, password, role, status, phone_verified: 0, email_verified: 0, created_at: createdAt });
        return { rows: [], rowCount: 1 };
      }

      // SELECT 1 FROM users WHERE phone=?
      if (/^SELECT 1 FROM users WHERE phone=\?/i.test(trimmed)) {
        const phone = params[0];
        const exists = [...state.users.values()].some(u => u.phone === phone);
        return { rows: exists ? [{ 1: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      // SELECT 1 FROM users WHERE lower(email)=\?
      if (/^SELECT 1 FROM users WHERE lower\(email\)=\?/i.test(trimmed)) {
        const email = String(params[0]).toLowerCase();
        const exists = [...state.users.values()].some(u => (u.email || '').toLowerCase() === email);
        return { rows: exists ? [{ 1: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      // SELECT * FROM users WHERE phone=?
      if (/^SELECT \* FROM users WHERE phone=\?/i.test(trimmed)) {
        const phone = params[0];
        const user = [...state.users.values()].find(u => u.phone === phone);
        return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
      }

      // SELECT * FROM users WHERE lower(email)=lower(?)
      if (/^SELECT \* FROM users WHERE lower\(email\)=lower\(\?\)/i.test(trimmed)) {
        const email = String(params[0]).toLowerCase();
        const user = [...state.users.values()].find(u => (u.email || '').toLowerCase() === email);
        return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
      }

      // SELECT * FROM users WHERE id=?
      if (/^SELECT \* FROM users WHERE id=\?/i.test(trimmed)) {
        const id = params[0];
        const user = state.users.get(id);
        return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
      }

      // SELECT id, name, phone, email, role, status, phone_verified, email_verified FROM users WHERE id=?
      if (/^SELECT id, name, phone, email, role, status, phone_verified, email_verified FROM users WHERE id=\?/i.test(trimmed)) {
        const id = params[0];
        const user = state.users.get(id);
        return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
      }

      // SELECT password FROM users WHERE id=?
      if (/^SELECT password FROM users WHERE id=\?/i.test(trimmed)) {
        const id = params[0];
        const user = state.users.get(id);
        return { rows: user ? [{ password: user.password }] : [], rowCount: user ? 1 : 0 };
      }

      // SELECT id FROM users WHERE role='ADMIN'
      if (/SELECT id FROM users WHERE role='ADMIN'/i.test(trimmed)) {
        const admins = [...state.users.values()].filter(u => u.role === 'ADMIN').map(u => ({ id: u.id }));
        return { rows: admins, rowCount: admins.length };
      }

      // UPDATE users SET password=? WHERE id=?
      if (/^UPDATE users SET password=\? WHERE id=\?/i.test(trimmed)) {
        const [pw, id] = params;
        const u = state.users.get(id);
        if (u) u.password = pw;
        return { rows: [], rowCount: u ? 1 : 0 };
      }

      // UPDATE users SET name=?, phone=?, email=?, phone_verified=?, email_verified=? WHERE id=?
      if (/^UPDATE users SET name=\?, phone=\?, email=\?, phone_verified=\?, email_verified=\? WHERE id=\?/i.test(trimmed)) {
        const [name, phone, email, phone_verified, email_verified, id] = params;
        const u = state.users.get(id);
        if (u) Object.assign(u, { name, phone, email, phone_verified, email_verified });
        return { rows: [], rowCount: u ? 1 : 0 };
      }

      // UPDATE users SET phone_verified=1 / email_verified=1 WHERE id=?
      if (/^UPDATE users SET (phone_verified|email_verified)=1 WHERE id=\?/i.test(trimmed)) {
        const id = params[0];
        const field = trimmed.includes('phone_verified') ? 'phone_verified' : 'email_verified';
        const u = state.users.get(id);
        if (u) u[field] = 1;
        return { rows: [], rowCount: u ? 1 : 0 };
      }

      // INSERT INTO sessions
      if (/^INSERT INTO sessions/i.test(trimmed)) {
        const [token_hash, user_id, expires_at, created_at] = params;
        state.sessions.set(token_hash, { token_hash, user_id, expires_at, created_at });
        return { rows: [], rowCount: 1 };
      }

      // SELECT user_id, expires_at FROM sessions WHERE token_hash=?
      if (/^SELECT user_id, expires_at FROM sessions WHERE token_hash=\?/i.test(trimmed)) {
        const hash = params[0];
        const s = state.sessions.get(hash);
        return { rows: s ? [{ user_id: s.user_id, expires_at: s.expires_at }] : [], rowCount: s ? 1 : 0 };
      }

      // DELETE FROM sessions WHERE token_hash=?
      if (/^DELETE FROM sessions WHERE token_hash=\?/i.test(trimmed)) {
        const hash = params[0];
        const existed = state.sessions.delete(hash);
        return { rows: [], rowCount: existed ? 1 : 0 };
      }

      // DELETE FROM sessions WHERE user_id=? AND token_hash<>?
      if (/^DELETE FROM sessions WHERE user_id=\? AND token_hash<>\?/i.test(trimmed)) {
        const [uid, hash] = params;
        let count = 0;
        for (const [k, v] of [...state.sessions.entries()]) {
          if (v.user_id === uid && k !== hash) {
            state.sessions.delete(k);
            count++;
          }
        }
        return { rows: [], rowCount: count };
      }

      // DELETE FROM sessions WHERE user_id=?
      if (/^DELETE FROM sessions WHERE user_id=\?/i.test(trimmed)) {
        const uid = params[0];
        let count = 0;
        for (const [k, v] of [...state.sessions.entries()]) {
          if (v.user_id === uid) {
            state.sessions.delete(k);
            count++;
          }
        }
        return { rows: [], rowCount: count };
      }

      // DELETE FROM sessions WHERE expires_at<?
      if (/^DELETE FROM sessions WHERE expires_at<\?/i.test(trimmed)) {
        const cutoff = params[0];
        let count = 0;
        for (const [k, v] of [...state.sessions.entries()]) {
          if (v.expires_at < cutoff) {
            state.sessions.delete(k);
            count++;
          }
        }
        return { rows: [], rowCount: count };
      }

      // INSERT INTO addresses
      if (/^INSERT INTO addresses/i.test(trimmed)) {
        const [id, user_id, label, name, phone, address, area, is_default] = params;
        state.addresses.set(id, { id, user_id, label, name, phone, address, area, is_default });
        return { rows: [], rowCount: 1 };
      }

      // INSERT INTO seller_profiles
      if (/^INSERT INTO seller_profiles/i.test(trimmed)) {
        const [user_id, shop_name, shop_address, business_info, kyc_nid, kyc_trade_license, status, commission_bps, created_at] = params;
        state.seller_profiles.set(user_id, { user_id, shop_name, shop_address, business_info, kyc_nid, kyc_trade_license, status, commission_bps, created_at });
        return { rows: [], rowCount: 1 };
      }

      // SELECT 1 FROM seller_profiles WHERE lower(shop_name)=lower(?)
      if (/^SELECT 1 FROM seller_profiles WHERE lower\(shop_name\)=lower\(\?\)/i.test(trimmed)) {
        const shop = String(params[0]).toLowerCase();
        const exists = [...state.seller_profiles.values()].some(s => s.shop_name.toLowerCase() === shop);
        return { rows: exists ? [{ 1: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      // SELECT shop_name, status FROM seller_profiles WHERE user_id=?
      if (/^SELECT shop_name, status FROM seller_profiles WHERE user_id=\?/i.test(trimmed)) {
        const uid = params[0];
        const s = state.seller_profiles.get(uid);
        return { rows: s ? [{ shop_name: s.shop_name, status: s.status }] : [], rowCount: s ? 1 : 0 };
      }

      // INSERT INTO otp_codes
      if (/^INSERT INTO otp_codes/i.test(trimmed)) {
        const [id, user_id, purpose, code_hash, expires_at, created_at] = params;
        state.otp_codes.set(id, { id, user_id, purpose, code_hash, attempts: 0, expires_at, used_at: null, created_at });
        return { rows: [], rowCount: 1 };
      }

      // UPDATE otp_codes SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL
      if (/^UPDATE otp_codes SET used_at=\? WHERE user_id=\? AND purpose=\? AND used_at IS NULL/i.test(trimmed)) {
        const [ts, uid, purpose] = params;
        let count = 0;
        for (const otp of state.otp_codes.values()) {
          if (otp.user_id === uid && otp.purpose === purpose && otp.used_at === null) {
            otp.used_at = ts;
            count++;
          }
        }
        return { rows: [], rowCount: count };
      }

      // SELECT * FROM otp_codes WHERE user_id=? AND purpose=? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1
      if (/^SELECT \* FROM otp_codes WHERE user_id=\? AND purpose=\? AND used_at IS NULL/i.test(trimmed)) {
        const [uid, purpose] = params;
        const matching = [...state.otp_codes.values()]
          .filter(o => o.user_id === uid && o.purpose === purpose && (o.used_at === null || o.used_at === undefined))
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        return { rows: matching.slice(0, 1), rowCount: matching.length ? 1 : 0 };
      }

      // UPDATE otp_codes SET attempts=attempts+1 WHERE id=?
      if (/^UPDATE otp_codes SET attempts=attempts\+1 WHERE id=\?/i.test(trimmed)) {
        const id = params[0];
        const o = state.otp_codes.get(id);
        if (o) o.attempts++;
        return { rows: [], rowCount: o ? 1 : 0 };
      }

      // UPDATE otp_codes SET used_at=? WHERE id=?
      if (/^UPDATE otp_codes SET used_at=\? WHERE id=\?/i.test(trimmed)) {
        const [ts, id] = params;
        const o = state.otp_codes.get(id);
        if (o) o.used_at = ts;
        return { rows: [], rowCount: o ? 1 : 0 };
      }

      // INSERT INTO audit_logs
      if (/^INSERT INTO audit_logs/i.test(trimmed)) {
        const [id, actor_id, action, entity, entity_id, detail, created_at] = params;
        state.audit_logs.push({ id, actor_id, action, entity, entity_id, detail, created_at });
        return { rows: [], rowCount: 1 };
      }

      // INSERT INTO notifications
      if (/^INSERT INTO notifications/i.test(trimmed)) {
        const [id, user_id, title, body, read, created_at] = params;
        state.notifications.push({ id, user_id, title, body, read, created_at });
        return { rows: [], rowCount: 1 };
      }

      // SELECT id, title, body, read, created_at FROM notifications WHERE user_id=?
      if (/^SELECT id, title, body, read, created_at FROM notifications WHERE user_id=\?/i.test(trimmed)) {
        const uid = params[0];
        const notifs = state.notifications.filter(n => n.user_id === uid);
        return { rows: notifs, rowCount: notifs.length };
      }

      // UPDATE notifications SET read=1 WHERE user_id=?
      if (/^UPDATE notifications SET read=1 WHERE user_id=\?/i.test(trimmed)) {
        const uid = params[0];
        let count = 0;
        for (const n of state.notifications) {
          if (n.user_id === uid) {
            n.read = 1;
            count++;
          }
        }
        return { rows: [], rowCount: count };
      }

      throw new Error('Unhandled query in mock: ' + trimmed);
    },
    async connect() {
      return {
        query: (sql, params) => pool.query(sql, params),
        release() {}
      };
    }
  };

  const database = createPostgresDatabase(pool);
  return { database, state, pool };
}

test('PostgreSQL auth repository registers customers and creates session and address', async () => {
  const { database, state } = createMockDatabase();
  const auth = createPostgresAuthRepository(database);

  const res = await auth.registerCustomer({
    name: 'Customer Test',
    phone: '01711111111',
    password: 'Password@123',
    confirm_password: 'Password@123',
    address: 'Gulshan 2, Dhaka',
    area: 'Dhaka'
  });

  assert.ok(res.token);
  assert.equal(res.data.name, 'Customer Test');
  assert.equal(res.data.role, 'CUSTOMER');
  assert.equal(state.users.size, 1);
  assert.equal(state.addresses.size, 1);
  assert.equal(state.sessions.size, 1);
  assert.equal(state.audit_logs.length, 1);
  assert.equal(state.audit_logs[0].action, 'CUSTOMER_REGISTER');
});

test('PostgreSQL auth repository rejects duplicate phone numbers on registration', async () => {
  const { database } = createMockDatabase();
  const auth = createPostgresAuthRepository(database);

  await auth.registerCustomer({
    name: 'Customer One',
    phone: '01711111111',
    password: 'Password@123',
    confirm_password: 'Password@123'
  });

  await assert.rejects(
    auth.registerCustomer({
      name: 'Customer Duplicate',
      phone: '01711111111',
      password: 'Password@123',
      confirm_password: 'Password@123'
    }),
    err => err.status === 409
  );
});

test('PostgreSQL auth repository registers seller atomically with seller_profile and notifies admin', async () => {
  const { database, state } = createMockDatabase();
  const auth = createPostgresAuthRepository(database);

  // Seed an admin user
  await database.q('INSERT INTO users(id, phone, email, name, password, role, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
    .run('admin-1', '01700000001', 'admin@example.com', 'Admin User', hashPassword('Admin@12345'), 'ADMIN', 'ACTIVE', new Date().toISOString());

  const res = await auth.registerSeller({
    name: 'Seller Test',
    phone: '01722222222',
    email: 'seller@test.com',
    password: 'Password@123',
    confirm_password: 'Password@123',
    shop_name: 'Test Fashion Shop',
    shop_address: 'Dhanmondi, Dhaka',
    business_info: 'Retailer',
    kyc_nid: '1234567890'
  });

  assert.ok(res.token);
  assert.equal(res.data.role, 'SELLER');
  assert.equal(res.data.status, 'PENDING');
  assert.equal(state.seller_profiles.size, 1);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].user_id, 'admin-1');
});

test('PostgreSQL auth repository logs in with phone or email, rejecting bad credentials and portal mismatch', async () => {
  const { database } = createMockDatabase();
  const auth = createPostgresAuthRepository(database);

  await auth.registerCustomer({
    name: 'Login User',
    phone: '01733333333',
    email: 'login@test.com',
    password: 'Password@123',
    confirm_password: 'Password@123'
  });

  // Login with phone
  const phoneLogin = await auth.login({ phone: '01733333333', password: 'Password@123' });
  assert.ok(phoneLogin.token);
  assert.equal(phoneLogin.data.phone, '01733333333');

  // Login with email identifier
  const emailLogin = await auth.login({ identifier: 'login@test.com', password: 'Password@123' });
  assert.ok(emailLogin.token);
  assert.equal(emailLogin.data.email, 'login@test.com');

  // Wrong password
  await assert.rejects(
    auth.login({ phone: '01733333333', password: 'WrongPassword' }),
    err => err.status === 401
  );

  // Portal mismatch (customer trying to access seller portal)
  await assert.rejects(
    auth.login({ phone: '01733333333', password: 'Password@123', portal: 'SELLER' }),
    err => err.status === 403
  );
});

test('PostgreSQL auth repository blocks suspended or inactive users', async () => {
  const { database } = createMockDatabase();
  const auth = createPostgresAuthRepository(database);

  await database.q('INSERT INTO users(id, phone, email, name, password, role, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
    .run('banned-1', '01744444444', null, 'Banned User', hashPassword('Password@123'), 'CUSTOMER', 'SUSPENDED', new Date().toISOString());

  await assert.rejects(
    auth.login({ phone: '01744444444', password: 'Password@123' }),
    err => err.status === 403
  );
});

test('PostgreSQL auth repository manages session validation, expiration, and logout', async () => {
  const { database, state } = createMockDatabase();
  const auth = createPostgresAuthRepository(database);

  const reg = await auth.registerCustomer({
    name: 'Session User',
    phone: '01755555555',
    password: 'Password@123',
    confirm_password: 'Password@123'
  });

  const user = await auth.getSessionUser(reg.token);
  assert.ok(user);
  assert.equal(user.phone, '01755555555');

  // Logout invalidates session
  await auth.logout(user);
  const loggedOutUser = await auth.getSessionUser(reg.token);
  assert.equal(loggedOutUser, null);

  // Expired session
  const expToken = await auth.createSession(user.id);
  const tokenHash = sha256(expToken);
  state.sessions.get(tokenHash).expires_at = '2000-01-01T00:00:00.000Z';
  assert.equal(await auth.getSessionUser(expToken), null);

  await auth.cleanupExpiredSessions();
  assert.equal(state.sessions.has(tokenHash), false);
});

test('PostgreSQL auth repository handles password change, invalidating other sessions', async () => {
  const { database, state } = createMockDatabase();
  const auth = createPostgresAuthRepository(database);

  const reg = await auth.registerCustomer({
    name: 'PwChange User',
    phone: '01766666666',
    password: 'OldPassword@123',
    confirm_password: 'OldPassword@123'
  });

  const session1 = reg.token;
  const session2 = await auth.createSession(reg.data.id);
  const user = await auth.getSessionUser(session1);

  await auth.changePassword(user, {
    current_password: 'OldPassword@123',
    new_password: 'NewPassword@456'
  });

  // Current session still valid
  assert.ok(await auth.getSessionUser(session1));
  // Other session revoked
  assert.equal(await auth.getSessionUser(session2), null);
});

test('PostgreSQL auth repository handles OTP verification, attempts limit, and password reset', async () => {
  const { database, state } = createMockDatabase();
  const auth = createPostgresAuthRepository(database);

  const reg = await auth.registerCustomer({
    name: 'Reset User',
    phone: '01777777777',
    password: 'Password@123',
    confirm_password: 'Password@123'
  });

  const forgot = await auth.forgotPassword({ identifier: '01777777777' });
  const code = forgot.dev_code;
  assert.ok(code);

  // Wrong code increments attempts
  await assert.rejects(
    auth.resetPassword({ identifier: '01777777777', code: '000000', new_password: 'ResetPass@999' }),
    err => err.message.includes('সঠিক নয়')
  );

  // Correct reset succeeds and revokes all sessions
  const resetRes = await auth.resetPassword({ identifier: '01777777777', code, new_password: 'ResetPass@999' });
  assert.equal(resetRes.reset, true);
  assert.equal(await auth.getSessionUser(reg.token), null);

  // Cannot reuse OTP code
  await assert.rejects(
    auth.resetPassword({ identifier: '01777777777', code, new_password: 'AnotherPass@123' }),
    err => err.message.includes('মেয়াদোত্তীর্ণ বা অবৈধ')
  );
});
