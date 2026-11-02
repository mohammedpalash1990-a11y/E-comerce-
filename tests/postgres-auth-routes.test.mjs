import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { createApiApp, sessionUser } from '../apps/api/src/server.modular.mjs';
import { hashPassword } from '../apps/api/src/core.mjs';

function createRouteHarness() {
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

      if (/^SELECT id FROM users WHERE id=\\? FOR UPDATE/i.test(trimmed)) {
        const user = state.users.get(params[0]);
        return { rows: user ? [{ id: user.id }] : [], rowCount: user ? 1 : 0 };
      }

      if (/^INSERT INTO users/i.test(trimmed)) {
        const [id, phone, email, name, password, role, status, createdAt] = params;
        state.users.set(id, { id, phone, email, name, password, role, status, phone_verified: 0, email_verified: 0, created_at: createdAt });
        return { rows: [], rowCount: 1 };
      }

      if (/^SELECT 1 FROM users WHERE phone=\?/i.test(trimmed)) {
        const phone = params[0];
        const exists = [...state.users.values()].some(u => u.phone === phone);
        return { rows: exists ? [{ 1: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      if (/^SELECT 1 FROM users WHERE lower\(email\)=\?/i.test(trimmed)) {
        const email = String(params[0]).toLowerCase();
        const exists = [...state.users.values()].some(u => (u.email || '').toLowerCase() === email);
        return { rows: exists ? [{ 1: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      if (/^SELECT \* FROM users WHERE phone=\?/i.test(trimmed)) {
        const phone = params[0];
        const user = [...state.users.values()].find(u => u.phone === phone);
        return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
      }

      if (/^SELECT \* FROM users WHERE lower\(email\)=lower\(\?\)/i.test(trimmed)) {
        const email = String(params[0]).toLowerCase();
        const user = [...state.users.values()].find(u => (u.email || '').toLowerCase() === email);
        return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
      }

      if (/^SELECT \* FROM users WHERE id=\?/i.test(trimmed)) {
        const id = params[0];
        const user = state.users.get(id);
        return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
      }

      if (/^SELECT id, name, phone, email, role, status, phone_verified, email_verified FROM users WHERE id=\?/i.test(trimmed)) {
        const id = params[0];
        const user = state.users.get(id);
        return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
      }

      if (/^SELECT password FROM users WHERE id=\?/i.test(trimmed)) {
        const id = params[0];
        const user = state.users.get(id);
        return { rows: user ? [{ password: user.password }] : [], rowCount: user ? 1 : 0 };
      }

      if (/SELECT id FROM users WHERE role='ADMIN'/i.test(trimmed)) {
        const admins = [...state.users.values()].filter(u => u.role === 'ADMIN').map(u => ({ id: u.id }));
        return { rows: admins, rowCount: admins.length };
      }

      if (/^UPDATE users SET password=\? WHERE id=\?/i.test(trimmed)) {
        const [pw, id] = params;
        const u = state.users.get(id);
        if (u) u.password = pw;
        return { rows: [], rowCount: u ? 1 : 0 };
      }

      if (/^UPDATE users SET name=\?, phone=\?, email=\?, phone_verified=\?, email_verified=\? WHERE id=\?/i.test(trimmed)) {
        const [name, phone, email, phone_verified, email_verified, id] = params;
        const u = state.users.get(id);
        if (u) Object.assign(u, { name, phone, email, phone_verified, email_verified });
        return { rows: [], rowCount: u ? 1 : 0 };
      }

      if (/^UPDATE users SET (phone_verified|email_verified)=1 WHERE id=\?/i.test(trimmed)) {
        const id = params[0];
        const field = trimmed.includes('phone_verified') ? 'phone_verified' : 'email_verified';
        const u = state.users.get(id);
        if (u) u[field] = 1;
        return { rows: [], rowCount: u ? 1 : 0 };
      }

      if (/^INSERT INTO sessions/i.test(trimmed)) {
        const [token_hash, user_id, expires_at, created_at] = params;
        state.sessions.set(token_hash, { token_hash, user_id, expires_at, created_at });
        return { rows: [], rowCount: 1 };
      }

      if (/^SELECT user_id, expires_at FROM sessions WHERE token_hash=\?/i.test(trimmed)) {
        const hash = params[0];
        const s = state.sessions.get(hash);
        return { rows: s ? [{ user_id: s.user_id, expires_at: s.expires_at }] : [], rowCount: s ? 1 : 0 };
      }

      if (/^DELETE FROM sessions WHERE token_hash=\?/i.test(trimmed)) {
        const hash = params[0];
        const existed = state.sessions.delete(hash);
        return { rows: [], rowCount: existed ? 1 : 0 };
      }

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

      if (/^INSERT INTO addresses/i.test(trimmed)) {
        const [id, user_id, label, name, phone, address, area, is_default] = params;
        state.addresses.set(id, { id, user_id, label, name, phone, address, area, is_default });
        return { rows: [], rowCount: 1 };
      }

      if (/^INSERT INTO seller_profiles/i.test(trimmed)) {
        const [user_id, shop_name, shop_address, business_info, kyc_nid, kyc_trade_license, status, commission_bps, created_at] = params;
        state.seller_profiles.set(user_id, { user_id, shop_name, shop_address, business_info, kyc_nid, kyc_trade_license, status, commission_bps, created_at });
        return { rows: [], rowCount: 1 };
      }

      if (/^SELECT 1 FROM seller_profiles WHERE lower\(shop_name\)=lower\(\?\)/i.test(trimmed)) {
        const shop = String(params[0]).toLowerCase();
        const exists = [...state.seller_profiles.values()].some(s => s.shop_name.toLowerCase() === shop);
        return { rows: exists ? [{ 1: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      if (/^SELECT shop_name, status FROM seller_profiles WHERE user_id=\?/i.test(trimmed)) {
        const uid = params[0];
        const s = state.seller_profiles.get(uid);
        return { rows: s ? [{ shop_name: s.shop_name, status: s.status }] : [], rowCount: s ? 1 : 0 };
      }

      if (/^INSERT INTO otp_codes/i.test(trimmed)) {
        const [id, user_id, purpose, code_hash, expires_at, created_at] = params;
        state.otp_codes.set(id, { id, user_id, purpose, code_hash, attempts: 0, expires_at, used_at: null, created_at });
        return { rows: [], rowCount: 1 };
      }

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

      if (/^SELECT \* FROM otp_codes WHERE user_id=\? AND purpose=\? AND used_at IS NULL/i.test(trimmed)) {
        const [uid, purpose] = params;
        const matching = [...state.otp_codes.values()]
          .filter(o => o.user_id === uid && o.purpose === purpose && (o.used_at === null || o.used_at === undefined))
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        return { rows: matching.slice(0, 1), rowCount: matching.length ? 1 : 0 };
      }

      if (/^UPDATE otp_codes SET attempts=attempts\+1 WHERE id=\?/i.test(trimmed)) {
        const id = params[0];
        const o = state.otp_codes.get(id);
        if (o) o.attempts++;
        return { rows: [], rowCount: o ? 1 : 0 };
      }

      if (/^UPDATE otp_codes SET used_at=\? WHERE id=\?/i.test(trimmed)) {
        const [ts, id] = params;
        const o = state.otp_codes.get(id);
        if (o) o.used_at = ts;
        return { rows: [], rowCount: o ? 1 : 0 };
      }

      if (/^INSERT INTO audit_logs/i.test(trimmed)) {
        const [id, actor_id, action, entity, entity_id, detail, created_at] = params;
        state.audit_logs.push({ id, actor_id, action, entity, entity_id, detail, created_at });
        return { rows: [], rowCount: 1 };
      }

      if (/^INSERT INTO notifications/i.test(trimmed)) {
        const [id, user_id, title, body, read, created_at] = params;
        state.notifications.push({ id, user_id, title, body, read, created_at });
        return { rows: [], rowCount: 1 };
      }

      if (/^SELECT id, title, body, read, created_at FROM notifications WHERE user_id=\?/i.test(trimmed)) {
        const uid = params[0];
        const notifs = state.notifications.filter(n => n.user_id === uid);
        return { rows: notifs, rowCount: notifs.length };
      }

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

      throw new Error('Unhandled query in route mock: ' + trimmed);
    },
    async connect() {
      return {
        query: (sql, params) => pool.query(sql, params),
        release() {}
      };
    }
  };

  const postgresDatabase = createPostgresDatabase(pool);
  const authRepository = createPostgresAuthRepository(postgresDatabase);
  const app = createApiApp({ authRepository });

  async function dispatch(method, pathAndQuery, { token, body } = {}) {
    const url = new URL(pathAndQuery, 'http://localhost');
    const matched = app.routes.find(r => r.method === method && r.re.test(url.pathname));
    if (!matched) return { status: 404, body: { error: 'Not found' } };
    const m = url.pathname.match(matched.re);

    let user = null;
    if (matched.roles) {
      const req = { headers: { authorization: token ? 'Bearer ' + token : '' } };
      user = await sessionUser(req, app.authRepository);
      if (!user) return { status: 401, body: { error: 'Authentication required' } };
      if (matched.roles !== 'AUTH' && !matched.roles.includes(user.role)) {
        return { status: 403, body: { error: 'You do not have permission for this action' } };
      }
    }

    try {
      const out = await matched.handler({ url, params: m.slice(1), body: body || {}, user, ip: '127.0.0.1' });
      return { status: out.status || 200, body: out.body };
    } catch (err) {
      return { status: err.status || 500, body: { error: err.message, ...(err.extra || {}) } };
    }
  }

  return { dispatch, state, authRepository };
}

test('HTTP auth routes: registration, login, getMe, and logout via PostgreSQL auth repository', async () => {
  const { dispatch, state } = createRouteHarness();

  // 1. Register customer
  const regRes = await dispatch('POST', '/api/v1/auth/register', {
    body: {
      name: 'Rahim Khan',
      phone: '01712345678',
      email: 'rahim@test.com',
      password: 'Password@123',
      confirm_password: 'Password@123',
      address: 'Banani',
      area: 'Dhaka'
    }
  });
  assert.equal(regRes.status, 201);
  assert.ok(regRes.body.token);
  assert.equal(regRes.body.data.name, 'Rahim Khan');

  const customerToken = regRes.body.token;

  // 2. Fetch /api/v1/auth/me
  const meRes = await dispatch('GET', '/api/v1/auth/me', { token: customerToken });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.data.phone, '01712345678');
  assert.equal(meRes.body.data.role, 'CUSTOMER');
  assert.equal('password' in meRes.body.data, false);

  // 3. Login
  const loginRes = await dispatch('POST', '/api/v1/auth/login', {
    body: {
      identifier: '01712345678',
      password: 'Password@123'
    }
  });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.body.token);

  // 4. Logout
  const logoutRes = await dispatch('POST', '/api/v1/auth/logout', { token: loginRes.body.token });
  assert.equal(logoutRes.status, 200);
  assert.equal(logoutRes.body.data.loggedOut, true);

  // 5. Subsequent request with logged out token is rejected
  const afterLogout = await dispatch('GET', '/api/v1/auth/me', { token: loginRes.body.token });
  assert.equal(afterLogout.status, 401);
});

test('HTTP auth routes: seller registration, notification, and profile lookup', async () => {
  const { dispatch, state } = createRouteHarness();

  // Register seller
  const regSeller = await dispatch('POST', '/api/v1/auth/register-seller', {
    body: {
      name: 'Seller Karim',
      phone: '01799999999',
      email: 'karim@shop.com',
      password: 'Password@123',
      confirm_password: 'Password@123',
      shop_name: 'Karim Handicrafts',
      shop_address: 'Mirpur 10, Dhaka',
      business_info: 'Crafts',
      kyc_nid: '1234567890123'
    }
  });
  assert.equal(regSeller.status, 201);
  assert.equal(regSeller.body.data.role, 'SELLER');
  assert.equal(regSeller.body.data.status, 'PENDING');

  const sellerToken = regSeller.body.token;

  // Seller profile lookup via /api/v1/auth/me
  const meRes = await dispatch('GET', '/api/v1/auth/me', { token: sellerToken });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.data.seller.shop_name, 'Karim Handicrafts');
  assert.equal(meRes.body.data.seller.status, 'PENDING');
});
