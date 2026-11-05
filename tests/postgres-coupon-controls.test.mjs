import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresCouponRepository } from '../apps/api/src/postgres-coupons.mjs';

test('per-customer coupon limits reject repeat use and allow another customer', async () => {
  const calls = [];
  const database = { q(sql) { return { async get(...args) {
    calls.push({ sql, args });
    if (sql.includes('FROM coupons')) return {
      code: 'SAVE', type: 'FIXED', value: '500', min_order_paisa: '0',
      max_uses: null, used_count: '1', max_uses_per_customer: '1', expires_at: null, active: '1'
    };
    if (sql.includes('FROM coupon_redemptions')) return { redemption_count: args[1] === 'buyer-1' ? '1' : '0' };
    return undefined;
  } }; } };
  const coupons = createPostgresCouponRepository(database, { now: () => '2026-11-04T12:00:00.000Z' });
  await assert.rejects(coupons.validateCoupon('SAVE', 2000, { userId: 'buyer-1' }), error => error.status === 400);
  assert.deepEqual(await coupons.validateCoupon('SAVE', 2000, { userId: 'buyer-2' }), { code: 'SAVE', discount: 500 });
  assert.deepEqual(calls.filter(x => x.sql.includes('FROM coupon_redemptions')).map(x => x.args), [['SAVE', 'buyer-1'], ['SAVE', 'buyer-2']]);
});
