import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresCouponRepository, normalizeCouponCode } from '../apps/api/src/postgres-coupons.mjs';
import { registerPostgresCouponRoutes } from '../apps/api/src/postgres-coupon-routes.mjs';

const current = '2026-11-04T12:00:00.000Z';
const row = { code: 'SAVE', type: 'FIXED', value: '250', min_order_paisa: '1000', max_uses: '5', used_count: '0', expires_at: null, active: '1' };
function setup(overrides = {}, options = {}) {
  const calls = [];
  const db = { q(sql) { return { async get(...args) { calls.push({ sql, args }); return options.missing ? undefined : { ...row, ...overrides }; } }; } };
  return { calls, repo: createPostgresCouponRepository(db, { now: () => current }) };
}

test('coupon codes normalize consistently; malformed codes never reach SQL', async () => {
  assert.equal(normalizeCouponCode('  saVe_2-test '), 'SAVE_2-TEST');
  for (const value of [undefined, null, '', ' ']) assert.equal(normalizeCouponCode(value), null);
  const h = setup();
  for (const code of [false, 0, true, [], {}, 'A'.repeat(31), "' OR 1=1", 'SAVE NOW', 'বাংলা', 'A\u0000B']) {
    await assert.rejects(h.repo.validateCoupon(code, 2000), error => error.status === 400);
  }
  assert.equal(await h.repo.validateCoupon(null, 2000), null);
  assert.deepEqual(h.calls, []);
});

test('fixed coupons use persisted paisa, minimum-order boundaries and a subtotal cap', async () => {
  const h = setup();
  assert.deepEqual(await h.repo.validateCoupon(' save ', 1000), { code: 'SAVE', discount: 250 });
  assert.deepEqual(h.calls[0].args, ['SAVE']);
  await assert.rejects(h.repo.validateCoupon('SAVE', 999), error => error.status === 400 && /minimum/.test(error.message));
  const capped = setup({ min_order_paisa: 0, value: 5000 });
  assert.equal((await capped.repo.validateCoupon('SAVE', 101)).discount, 101);
});

test('percentage discounts floor exact integer arithmetic without large-subtotal rounding errors', async () => {
  const h = setup({ type: 'PERCENT', value: 17, min_order_paisa: 0 });
  assert.equal((await h.repo.validateCoupon('SAVE', 101)).discount, 17);
  const large = setup({ type: 'PERCENT', value: 90, min_order_paisa: 0 });
  const subtotal = Number.MAX_SAFE_INTEGER;
  assert.equal((await large.repo.validateCoupon('SAVE', subtotal)).discount, Number(BigInt(subtotal) * 90n / 100n));
});

test('unknown, disabled and exhausted coupons fail with the same public eligibility error', async () => {
  for (const h of [setup({}, { missing: true }), setup({ active: 0 }), setup({ active: 2 }), setup({ used_count: 5 }), setup({ used_count: 6 })]) {
    await assert.rejects(h.repo.validateCoupon('SAVE', 2000), error => error.status === 400 && error.message === 'Coupon is invalid, expired or unavailable');
  }
  assert.equal((await setup({ max_uses: null, used_count: 999 }).repo.validateCoupon('SAVE', 2000)).discount, 250);
});

test('expiry handles exact boundaries, offsets and legacy UTC dates without lexical comparisons', async () => {
  for (const expiry of ['2026-11-04T12:00:00.000Z', '2026-11-04T17:59:59+06:00', '2026-11-04']) {
    await assert.rejects(setup({ expires_at: expiry }).repo.validateCoupon('SAVE', 2000), error => error.status === 400);
  }
  for (const expiry of ['2026-11-04T12:00:00.001Z', '2026-11-04T18:00:01+06:00', '2026-11-05']) {
    assert.equal((await setup({ expires_at: expiry }).repo.validateCoupon('SAVE', 2000)).discount, 250);
  }
});

test('invalid dates and timezone-less timestamps fail closed instead of becoming perpetual coupons', async () => {
  for (const expiry of ['', 'tomorrow', '2026-02-30', '2026-02-30T12:00:00Z', '2026-11-04T13:00:00', '2026-11-04T24:00:00Z', '2026-13-01', 123]) {
    await assert.rejects(setup({ expires_at: expiry }).repo.validateCoupon('SAVE', 2000), error => error.status === 400);
  }
});

test('corrupt amounts, counters and unsupported coupon types are never interpreted as discounts', async () => {
  for (const patch of [
    { value: 0 }, { value: -1 }, { value: null }, { value: '1.5' }, { value: '9007199254740993' },
    { min_order_paisa: -1 }, { min_order_paisa: null }, { used_count: -1 }, { used_count: Number.MAX_SAFE_INTEGER },
    { max_uses: 0 }, { max_uses: -1 }, { max_uses: '1.5' }, { type: 'UNKNOWN' }, { type: 'PERCENT', value: 91 }
  ]) await assert.rejects(setup(patch).repo.validateCoupon('SAVE', 2000), error => error.status === 400);
  for (const subtotal of [null, undefined, -1, 1.5, NaN, Infinity, '9007199254740993']) {
    await assert.rejects(setup().repo.validateCoupon('SAVE', subtotal), error => error.status === 400);
  }
});

test('checkout validation requests a row lock while preview validation never mutates counters', async () => {
  const h = setup();
  await h.repo.validateCoupon('SAVE', 2000);
  assert.doesNotMatch(h.calls[0].sql, /FOR UPDATE/);
  await h.repo.validateCoupon('SAVE', 2000, { lock: true });
  assert.match(h.calls[1].sql, /FOR UPDATE$/);
  assert.ok(h.calls.every(call => call.sql.startsWith('SELECT')));
});

test('expiry is sampled after lock acquisition, not before a blocked query', async () => {
  let clock = '2026-11-04T11:59:00.000Z';
  const database = { q() { return { async get() { clock = current; return { ...row, expires_at: current }; } }; } };
  const repo = createPostgresCouponRepository(database, { now: () => clock });
  await assert.rejects(repo.validateCoupon('SAVE', 2000, { lock: true }), error => error.status === 400);
});

function previewSetup({ empty = false, available = true } = {}) {
  const calls = [], routes = [];
  const database = {
    async tx(fn) { calls.push({ sql: 'BEGIN' }); const result = await fn(); calls.push({ sql: 'COMMIT' }); return result; },
    q(sql) { return {
      async run(...args) { calls.push({ sql, args }); },
      async all(...args) {
        calls.push({ sql, args });
        return empty ? [] : [{ product_id: 'p1', name_bn: 'চা', name_en: 'Tea', price_paisa: 1500, discount_paisa: null,
          quantity: 2, stock: available ? 2 : 0, active: 1, status: 'ACTIVE', seller_status: 'APPROVED', image: null }];
      },
      async get(...args) { calls.push({ sql, args }); return { ...row, expires_at: null }; }
    }; }
  };
  registerPostgresCouponRoutes((method, path, roles, handler) => routes.push({ method, path, roles, handler }), data => ({ data }), { database });
  return { calls, route: routes[0] };
}

test('coupon preview is CUSTOMER-only and uses a read-only saved-cart snapshot, not client pricing or ownership', async () => {
  const h = previewSetup();
  assert.equal(h.route.method, 'POST');
  assert.equal(h.route.path, '/api/v1/coupons/validate');
  assert.deepEqual(h.route.roles, ['CUSTOMER']);
  const result = await h.route.handler({ user: { id: 'buyer' }, body: { code: 'SAVE', subtotal_bdt: 999999, user_id: 'victim', discount_bdt: 9999 } });
  assert.deepEqual(result, { data: { code: 'SAVE', discount_bdt: 2.5, subtotal_bdt: 30 } });
  assert.equal(h.calls[1].sql, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(h.calls.find(call => call.sql.includes('FROM cart_items')).args, ['buyer']);
  assert.ok(!h.calls.some(call => /UPDATE coupons|INSERT|DELETE|FOR UPDATE/.test(call.sql)));
});

test('preview rejects missing codes, empty carts and unavailable items before coupon lookup', async () => {
  const missing = previewSetup();
  await assert.rejects(missing.route.handler({ user: { id: 'buyer' }, body: {} }), error => error.status === 400);
  assert.deepEqual(missing.calls, []);
  for (const [options, status] of [[{ empty: true }, 400], [{ available: false }, 409]]) {
    const h = previewSetup(options);
    await assert.rejects(h.route.handler({ user: { id: 'buyer' }, body: { code: 'SAVE' } }), error => error.status === status);
    assert.ok(!h.calls.some(call => call.sql.includes('FROM coupons')));
  }
});
