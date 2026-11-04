import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresAdminCouponRoutes } from '../apps/api/src/postgres-admin-coupon-routes.mjs';

const current = '2026-11-04T12:00:00.000Z';
const admin = { id: 'admin-1', role: 'ADMIN' };
const record = { code: 'SAVE', type: 'FIXED', value: '500', min_order_paisa: '1000', max_uses: '5', used_count: '2', expires_at: null, active: '1' };
function setup({ coupon, activeAdmin = true, failAudit = false } = {}) {
  const routes = [], calls = [], coupons = new Map(coupon ? [[coupon.code, { ...coupon }]] : []), audits = [];
  let next = 0;
  const database = {
    async tx(fn) {
      calls.push({ sql: 'BEGIN' });
      const before = structuredClone(coupons), auditCount = audits.length;
      try { const result = await fn(); calls.push({ sql: 'COMMIT' }); return result; }
      catch (error) { coupons.clear(); for (const entry of before) coupons.set(...entry); audits.length = auditCount; calls.push({ sql: 'ROLLBACK' }); throw error; }
    },
    q(sql) { return {
      async get(...args) {
        calls.push({ sql, args });
        if (sql.includes('FROM users')) return activeAdmin ? { id: args[0] } : undefined;
        if (sql.includes('FROM coupons')) return coupons.get(args[0]);
        throw new Error('Unexpected read');
      },
      async all(...args) { calls.push({ sql, args }); return [...coupons.values()]; },
      async run(...args) {
        calls.push({ sql, args });
        if (sql.startsWith('INSERT INTO coupons')) {
          if (coupons.has(args[0])) throw Object.assign(new Error('duplicate'), { code: '23505' });
          const [code, type, value, min_order_paisa, max_uses, max_uses_per_customer, expires_at, active] = args;
          coupons.set(code, { code, type, value, min_order_paisa, max_uses, max_uses_per_customer, used_count: 0, expires_at, active });
        } else if (sql.startsWith('UPDATE coupons')) coupons.get(args[1]).active = args[0];
        else if (sql.startsWith('INSERT INTO audit_logs')) {
          if (failAudit) throw new Error('audit unavailable');
          audits.push(args);
        } else throw new Error('Unexpected write');
      }
    }; }
  };
  registerPostgresAdminCouponRoutes((method, path, roles, handler) => routes.push({ method, path, roles, handler }),
    (data, status = 200) => ({ data, status }), { database, id: () => 'audit-' + ++next, now: () => current });
  const invoke = (method, body, code = 'SAVE') => routes.find(route => route.method === method).handler({ user: admin, body, params: [code], url: new URL('https://example.test/?' + (typeof body === 'string' ? body : '')) });
  return { routes, calls, coupons, audits, invoke };
}

test('admin coupon routes preserve paths and require ADMIN plus transactional persistence', () => {
  const h = setup();
  assert.deepEqual(h.routes.map(({ method, path, roles }) => ({ method, path, roles })), [
    { method: 'GET', path: '/api/v1/admin/coupons', roles: ['ADMIN'] },
    { method: 'POST', path: '/api/v1/admin/coupons', roles: ['ADMIN'] },
    { method: 'PATCH', path: '/api/v1/admin/coupons/:code', roles: ['ADMIN'] }
  ]);
  assert.throws(() => registerPostgresAdminCouponRoutes(() => {}, () => {}, { database: { q() {} } }), /transactions/);
});

test('fixed coupon creation converts decimal BDT exactly, normalizes expiry and records an atomic audit', async () => {
  const h = setup();
  const result = await h.invoke('POST', { code: ' save ', type: 'FIXED', value: '0.29', min_order_bdt: '10.05', max_uses: '2', expires_at: '2026-11-05T06:00:00+06:00', active: false });
  assert.deepEqual(result, { status: 201, data: { code: 'SAVE' } });
  assert.deepEqual(h.coupons.get('SAVE'), { code: 'SAVE', type: 'FIXED', value: 29, min_order_paisa: 1005, max_uses: 2, max_uses_per_customer: null, used_count: 0, expires_at: '2026-11-05T00:00:00.000Z', active: 0 });
  assert.equal(h.calls[0].sql, 'BEGIN');
  assert.match(h.calls[1].sql, /role='ADMIN'.*FOR SHARE/);
  assert.equal(h.audits[0][1], admin.id);
  assert.equal(h.audits[0][2], 'COUPON_CREATE');
  assert.equal(h.audits[0][3], 'coupon');
  assert.equal(JSON.parse(h.audits[0][5]).value, 29);
  assert.equal(h.calls.at(-1).sql, 'COMMIT');
});

test('percentage creation preserves the explicit whole-percent contract and optional defaults', async () => {
  const h = setup();
  await h.invoke('POST', { code: 'PERCENT', type: 'PERCENT', value: '17' });
  assert.deepEqual(h.coupons.get('PERCENT'), { code: 'PERCENT', type: 'PERCENT', value: 17, min_order_paisa: 0, max_uses: null, max_uses_per_customer: null, used_count: 0, expires_at: null, active: 1 });
});

test('admin can set and read an explicit per-customer coupon redemption limit', async () => {
  const h = setup();
  await h.invoke('POST', { code: 'ONEPERUSER', type: 'FIXED', value: '2.50', max_uses_per_customer: '1' });
  assert.equal(h.coupons.get('ONEPERUSER').max_uses_per_customer, 1);
  const listed = await h.invoke('GET', '');
  assert.equal(listed.data[0].max_uses_per_customer, 1);
  assert.equal(JSON.parse(h.audits[0][5]).max_uses_per_customer, 1);
});

test('unsafe monetary input, malformed types and privileged fields are rejected before any mutation', async () => {
  const h = setup(), valid = { code: 'SAVE', type: 'FIXED', value: '1.01' };
  for (const patch of [
    { code: '' }, { code: {} }, { type: undefined }, { type: 'OTHER' },
    { value: null }, { value: true }, { value: [] }, { value: '' }, { value: '1e2' }, { value: '1.005' },
    { value: 0 }, { value: -1 }, { value: '90071992547409.92' }, { value: Infinity },
    { type: 'PERCENT', value: 91 }, { type: 'PERCENT', value: 1.5 },
    { min_order_bdt: -1 }, { min_order_bdt: null }, { min_order_bdt: '0.001' },
    { max_uses: 0 }, { max_uses: false }, { max_uses: '1.5' }, { max_uses: '9007199254740992' },
    { active: 'false' }, { active: 0 }, { used_count: 0 }, { actor_id: 'another-admin' }, { value_paisa: 999 },
    { expires_at: '2026-02-30' }, { expires_at: '2030-01-01T12:00:00' }
  ]) await assert.rejects(h.invoke('POST', { ...valid, ...patch }), error => error.status === 400);
  assert.equal(h.calls.length, 0);
  assert.equal(h.coupons.size, 0);
});

test('past or exact-boundary expiry is rejected even when initially inactive', async () => {
  const h = setup();
  for (const expires_at of ['2020-01-01', current]) await assert.rejects(h.invoke('POST', { code: 'SAVE', type: 'FIXED', value: 1, expires_at, active: false }), error => error.status === 400);
  assert.equal(h.coupons.size, 0);
  assert.equal(h.audits.length, 0);
  assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
});

test('listing preserves stored-unit fields, adds BDT helpers and binds bounded pagination/filter values', async () => {
  const h = setup({ coupon: record });
  const result = await h.invoke('GET', 'limit=25&offset=50&active=1');
  assert.deepEqual(h.calls[0].args, [1, 25, 50]);
  assert.match(h.calls[0].sql, /WHERE active=\? ORDER BY code LIMIT \? OFFSET \?/);
  assert.deepEqual(result.data[0], { ...record, value: 500, min_order_paisa: 1000, max_uses: 5, max_uses_per_customer: null, used_count: 2, active: 1, value_bdt: 5, min_order_bdt: 10 });
  await h.invoke('GET', '');
  assert.deepEqual(h.calls[1].args, [100, 0]);
});

test('malformed and duplicate pagination/filter parameters are rejected instead of unbounded scans', async () => {
  const h = setup();
  for (const query of ['limit=0', 'limit=301', 'offset=-1', 'offset=10001', 'limit=1.5', 'limit=1e2', 'limit=', 'active=true', 'active=2', 'limit=1&limit=2']) {
    await assert.rejects(h.invoke('GET', query), error => error.status === 400);
  }
  assert.equal(h.calls.length, 0);
});

test('toggle locks the coupon and changes only active, preserving usage and discount terms', async () => {
  const h = setup({ coupon: record });
  assert.deepEqual(await h.invoke('PATCH', { active: false }, 'save'), { status: 200, data: { code: 'SAVE', active: false } });
  assert.match(h.calls[2].sql, /FROM coupons WHERE code=\? FOR UPDATE/);
  assert.equal(h.coupons.get('SAVE').used_count, '2');
  assert.equal(h.coupons.get('SAVE').value, '500');
  assert.ok(h.calls.some(call => call.sql === 'UPDATE coupons SET active=? WHERE code=?'));
  assert.equal(h.audits[0][2], 'COUPON_TOGGLE');
  assert.deepEqual(JSON.parse(h.audits[0][5]), { from_active: 1, active: false, used_count: 2 });
  const audits = h.audits.length;
  await h.invoke('PATCH', { active: false });
  assert.equal(h.audits.length, audits, 'same-state repeat is a no-op, not a duplicate audit');
  await h.invoke('PATCH', { active: true });
  assert.equal(h.audits.length, audits + 1);
});

test('PATCH requires an explicit boolean and refuses usage resets or economic edits', async () => {
  const h = setup({ coupon: record });
  for (const body of [{}, { active: 'false' }, { active: 0 }, { active: null }, { active: true, used_count: 0 }, { active: true, value: 1 }, { active: true, max_uses: 99 }]) {
    await assert.rejects(h.invoke('PATCH', body), error => error.status === 400);
  }
  assert.equal(h.calls.length, 0);
});

test('expired, exhausted or invalid coupons cannot be enabled but can be disabled', async () => {
  for (const patch of [{ expires_at: current }, { used_count: 5 }, { type: 'PERCENT', value: 91 }, { value: 0 }, { min_order_paisa: -1 }, { expires_at: 'not-a-date' }]) {
    const h = setup({ coupon: { ...record, ...patch, active: 0 } });
    await assert.rejects(h.invoke('PATCH', { active: true }), error => error.status === 409);
    h.coupons.get('SAVE').active = 1;
    assert.equal((await h.invoke('PATCH', { active: false })).data.active, false);
  }
});

test('missing coupons and inactive admin accounts cannot mutate records', async () => {
  const missing = setup();
  await assert.rejects(missing.invoke('PATCH', { active: false }), error => error.status === 404);
  const inactive = setup({ coupon: record, activeAdmin: false });
  await assert.rejects(inactive.invoke('POST', { code: 'NEW', type: 'FIXED', value: 1 }), error => error.status === 403);
  await assert.rejects(inactive.invoke('PATCH', { active: false }), error => error.status === 403);
  assert.ok(!inactive.calls.some(call => /INSERT|UPDATE coupons/.test(call.sql)));
});

test('audit failure rolls back both coupon creation and activation changes', async () => {
  const create = setup({ failAudit: true });
  await assert.rejects(create.invoke('POST', { code: 'NEW', type: 'FIXED', value: 1 }), /audit unavailable/);
  assert.equal(create.coupons.size, 0);
  const toggle = setup({ coupon: record, failAudit: true });
  await assert.rejects(toggle.invoke('PATCH', { active: false }), /audit unavailable/);
  assert.equal(toggle.coupons.get('SAVE').active, '1');
  assert.equal(toggle.calls.at(-1).sql, 'ROLLBACK');
});

test('duplicate normalized codes never overwrite existing terms or create an audit', async () => {
  const h = setup({ coupon: record });
  await assert.rejects(h.invoke('POST', { code: ' save ', type: 'FIXED', value: 999 }), error => error.code === '23505');
  assert.equal(h.coupons.get('SAVE').value, '500');
  assert.equal(h.audits.length, 0);
});
