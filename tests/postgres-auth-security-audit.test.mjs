import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';

// Keep this integration-style SQLite test isolated from parallel test files.
process.env.SQLITE_FILE = ':memory:';
const [{ createApiApp, createHttpServer }, { sha256, hashPassword }] = await Promise.all([
  import('../apps/api/src/server.modular.mjs'),
  import('../apps/api/src/core.mjs')
]);

function createInMemoryPostgresAdapter() {
  const tables = {
    users: new Map(),
    sessions: new Map(),
    addresses: new Map(),
    seller_profiles: new Map(),
    otp_codes: new Map(),
    audit_logs: [],
    notifications: []
  };

  const adapter = {
    tables,
    q(sql) {
      const trimmed = sql.trim();
      return {
        get: async (...params) => {
          if (/SELECT \* FROM users WHERE lower\(email\)=lower\(\?\)/i.test(trimmed)) {
            const email = String(params[0]).toLowerCase();
            return [...tables.users.values()].find(u => u.email && u.email.toLowerCase() === email);
          }
          if (/SELECT \* FROM users WHERE phone=\?/i.test(trimmed)) {
            return [...tables.users.values()].find(u => u.phone === params[0]);
          }
          if (/SELECT 1 FROM users WHERE phone=\?/i.test(trimmed)) {
            return tables.users.has(params[0]) ? { 1: 1 } : null;
          }
          if (/SELECT 1 FROM users WHERE lower\(email\)=\?/i.test(trimmed)) {
            const email = String(params[0]).toLowerCase();
            const found = [...tables.users.values()].some(u => u.email && u.email.toLowerCase() === email);
            return found ? { 1: 1 } : null;
          }
          if (/SELECT 1 FROM users WHERE phone=\? AND id<>\?/i.test(trimmed)) {
            const [phone, id] = params;
            const found = [...tables.users.values()].some(u => u.phone === phone && u.id !== id);
            return found ? { 1: 1 } : null;
          }
          if (/SELECT 1 FROM users WHERE lower\(email\)=\? AND id<>\?/i.test(trimmed)) {
            const [email, id] = params;
            const found = [...tables.users.values()].some(u => u.email && u.email.toLowerCase() === email.toLowerCase() && u.id !== id);
            return found ? { 1: 1 } : null;
          }
          if (/SELECT 1 FROM seller_profiles WHERE lower\(shop_name\)=lower\(\?\)/i.test(trimmed)) {
            const shop = String(params[0]).toLowerCase();
            const found = [...tables.seller_profiles.values()].some(s => s.shop_name && s.shop_name.toLowerCase() === shop);
            return found ? { 1: 1 } : null;
          }
          if (/SELECT user_id, expires_at FROM sessions WHERE token_hash=\?/i.test(trimmed)) {
            const s = tables.sessions.get(params[0]);
            return s ? { user_id: s.user_id, expires_at: s.expires_at } : null;
          }
          if (/SELECT id, name, phone, email, role, status, phone_verified, email_verified FROM users WHERE id=\?/i.test(trimmed)) {
            const u = [...tables.users.values()].find(x => x.id === params[0]);
            return u ? { ...u } : null;
          }
          if (/SELECT password FROM users WHERE id=\?/i.test(trimmed)) {
            const u = [...tables.users.values()].find(x => x.id === params[0]);
            return u ? { password: u.password } : null;
          }
          if (/SELECT \* FROM users WHERE id=\?/i.test(trimmed)) {
            const u = [...tables.users.values()].find(x => x.id === params[0]);
            return u ? { ...u } : null;
          }
          if (/SELECT shop_name, status FROM seller_profiles WHERE user_id=\?/i.test(trimmed)) {
            const s = tables.seller_profiles.get(params[0]);
            return s ? { shop_name: s.shop_name, status: s.status } : null;
          }
          if (/SELECT \* FROM otp_codes WHERE user_id=\? AND purpose=\? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1/i.test(trimmed)) {
            const [uid, purpose] = params;
            const matching = [...tables.otp_codes.values()]
              .filter(o => o.user_id === uid && o.purpose === purpose && o.used_at == null)
              .sort((a, b) => b.created_at.localeCompare(a.created_at));
            return matching[0] || null;
          }
          throw new Error('Unhandled query in get: ' + trimmed);
        },
        all: async (...params) => {
          if (/SELECT id FROM users WHERE role='ADMIN'/i.test(trimmed)) {
            return [...tables.users.values()].filter(u => u.role === 'ADMIN').map(u => ({ id: u.id }));
          }
          throw new Error('Unhandled query in all: ' + trimmed);
        },
        run: async (...params) => {
          if (/INSERT INTO users/i.test(trimmed)) {
            const [id, phone, email, name, password, role, status, created_at] = params;
            tables.users.set(phone, { id, phone, email, name, password, role, status, created_at, phone_verified: 0, email_verified: 0 });
            return { changes: 1 };
          }
          if (/INSERT INTO sessions/i.test(trimmed)) {
            const [token_hash, user_id, expires_at, created_at] = params;
            tables.sessions.set(token_hash, { token_hash, user_id, expires_at, created_at });
            return { changes: 1 };
          }
          if (/INSERT INTO addresses/i.test(trimmed)) {
            const [id, user_id, label, name, phone, address, area, is_default] = params;
            tables.addresses.set(id, { id, user_id, label, name, phone, address, area, is_default });
            return { changes: 1 };
          }
          if (/INSERT INTO seller_profiles/i.test(trimmed)) {
            const [user_id, shop_name, shop_address, business_info, kyc_nid, kyc_trade_license, status, commission_bps, created_at] = params;
            tables.seller_profiles.set(user_id, { user_id, shop_name, shop_address, business_info, kyc_nid, kyc_trade_license, status, commission_bps, created_at });
            return { changes: 1 };
          }
          if (/INSERT INTO audit_logs/i.test(trimmed)) {
            tables.audit_logs.push(params);
            return { changes: 1 };
          }
          if (/INSERT INTO notifications/i.test(trimmed)) {
            tables.notifications.push(params);
            return { changes: 1 };
          }
          if (/DELETE FROM sessions WHERE token_hash=\?/i.test(trimmed)) {
            tables.sessions.delete(params[0]);
            return { changes: 1 };
          }
          if (/DELETE FROM sessions WHERE user_id=\? AND token_hash<>\?/i.test(trimmed)) {
            const [uid, tokenHash] = params;
            for (const [k, v] of tables.sessions) {
              if (v.user_id === uid && v.token_hash !== tokenHash) tables.sessions.delete(k);
            }
            return { changes: 1 };
          }
          if (/DELETE FROM sessions WHERE user_id=\?/i.test(trimmed)) {
            const [uid] = params;
            for (const [k, v] of tables.sessions) {
              if (v.user_id === uid) tables.sessions.delete(k);
            }
            return { changes: 1 };
          }
          if (/UPDATE users SET password=\? WHERE id=\?/i.test(trimmed)) {
            const [newPass, uid] = params;
            const u = [...tables.users.values()].find(x => x.id === uid);
            if (u) u.password = newPass;
            return { changes: 1 };
          }
          if (/UPDATE users SET name=\?, phone=\?, email=\?, phone_verified=\?, email_verified=\? WHERE id=\?/i.test(trimmed)) {
            const [name, phone, email, phone_verified, email_verified, id] = params;
            const u = [...tables.users.values()].find(x => x.id === id);
            if (u) {
              tables.users.delete(u.phone);
              u.name = name;
              u.phone = phone;
              u.email = email;
              u.phone_verified = phone_verified;
              u.email_verified = email_verified;
              tables.users.set(phone, u);
            }
            return { changes: 1 };
          }
          if (/UPDATE otp_codes SET attempts=attempts\+1 WHERE id=\?/i.test(trimmed)) {
            const o = tables.otp_codes.get(params[0]);
            if (o) o.attempts += 1;
            return { changes: 1 };
          }
          if (/UPDATE otp_codes SET used_at=\? WHERE id=\? AND used_at IS NULL/i.test(trimmed)) {
            const [used_at, id] = params;
            const o = tables.otp_codes.get(id);
            if (o && o.used_at == null) o.used_at = used_at;
            return { changes: 1 };
          }
          if (/UPDATE otp_codes SET used_at=\? WHERE user_id=\? AND purpose=\? AND used_at IS NULL/i.test(trimmed)) {
            const [used_at, uid, purpose] = params;
            for (const o of tables.otp_codes.values()) {
              if (o.user_id === uid && o.purpose === purpose && o.used_at == null) {
                o.used_at = used_at;
              }
            }
            return { changes: 1 };
          }
          if (/INSERT INTO otp_codes/i.test(trimmed)) {
            const [id, user_id, purpose, code_hash, attempts, expires_at, used_at, created_at] = params;
            tables.otp_codes.set(id, { id, user_id, purpose, code_hash, attempts, expires_at, used_at, created_at });
            return { changes: 1 };
          }
          if (/UPDATE users SET phone_verified=1 WHERE id=\?/i.test(trimmed)) {
            const u = [...tables.users.values()].find(x => x.id === params[0]);
            if (u) u.phone_verified = 1;
            return { changes: 1 };
          }
          if (/UPDATE users SET email_verified=1 WHERE id=\?/i.test(trimmed)) {
            const u = [...tables.users.values()].find(x => x.id === params[0]);
            if (u) u.email_verified = 1;
            return { changes: 1 };
          }
          throw new Error('Unhandled query in run: ' + trimmed);
        }
      };
    },
    async tx(fn) {
      return fn();
    }
  };

  return adapter;
}

test('audit: role escalation prevention - registration ignores role in body and forces CUSTOMER', async () => {
  const db = createInMemoryPostgresAdapter();
  const auth = createPostgresAuthRepository(db);

  const reg = await auth.registerCustomer({
    name: 'Escalation Attempt',
    phone: '01712345678',
    password: 'Password@123',
    confirm_password: 'Password@123',
    role: 'ADMIN' // Malicious client injection attempt
  });

  assert.equal(reg.data.role, 'CUSTOMER');
  const user = await auth.getSessionUser(reg.token);
  assert.equal(user.role, 'CUSTOMER');
});

test('audit: role escalation prevention - seller registration forces SELLER and PENDING status', async () => {
  const db = createInMemoryPostgresAdapter();
  const auth = createPostgresAuthRepository(db);

  const reg = await auth.registerSeller({
    name: 'Seller Escalation',
    phone: '01712345679',
    email: 'seller@test.bd',
    password: 'Password@123',
    confirm_password: 'Password@123',
    shop_name: 'Test Shop',
    shop_address: 'Dhaka',
    business_info: 'Trading',
    kyc_nid: '1234567890',
    role: 'ADMIN', // Malicious attempt
    status: 'ACTIVE' // Malicious attempt
  });

  assert.equal(reg.data.role, 'SELLER');
  assert.equal(reg.data.status, 'PENDING');
  const user = await auth.getSessionUser(reg.token);
  assert.equal(user.role, 'SELLER');
});

test('audit: profile update cannot modify user role or status', async () => {
  const db = createInMemoryPostgresAdapter();
  const auth = createPostgresAuthRepository(db);

  const reg = await auth.registerCustomer({
    name: 'Normal User',
    phone: '01711112222',
    password: 'Password@123',
    confirm_password: 'Password@123'
  });

  const user = await auth.getSessionUser(reg.token);
  const updated = await auth.updateProfile(user, {
    name: 'Updated Name',
    role: 'ADMIN', // Try to escalate
    status: 'SUPERUSER'
  });

  assert.equal(updated.name, 'Updated Name');
  assert.equal(updated.role, 'CUSTOMER');
  const freshUser = await auth.getSessionUser(reg.token);
  assert.equal(freshUser.role, 'CUSTOMER');
});

test('audit: cross-account session isolation - sessions are strictly tied to the authenticating user', async () => {
  const db = createInMemoryPostgresAdapter();
  const auth = createPostgresAuthRepository(db);

  const user1 = await auth.registerCustomer({
    name: 'User 1',
    phone: '01711110001',
    password: 'Password@123',
    confirm_password: 'Password@123'
  });

  const user2 = await auth.registerCustomer({
    name: 'User 2',
    phone: '01711110002',
    password: 'Password@123',
    confirm_password: 'Password@123'
  });

  const session1 = await auth.getSessionUser(user1.token);
  const session2 = await auth.getSessionUser(user2.token);

  assert.notEqual(session1.id, session2.id);
  assert.equal(session1.phone, '01711110001');
  assert.equal(session2.phone, '01711110002');
});
