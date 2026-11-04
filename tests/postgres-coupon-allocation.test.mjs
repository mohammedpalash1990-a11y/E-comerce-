import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresCheckoutRepository } from '../apps/api/src/postgres-checkout.mjs';

test('checkout allocates coupon discount across seller orders and assigns the remainder deterministically', async () => {
  const products = new Map([
    ['p-a', { id: 'p-a', name_bn: 'A', price_paisa: 1000, stock: 5, active: 1, status: 'ACTIVE', seller_id: 'seller-a' }],
    ['p-b', { id: 'p-b', name_bn: 'B', price_paisa: 1000, stock: 5, active: 1, status: 'ACTIVE', seller_id: 'seller-b' }]
  ]);
  const sellerOrders = [];
  const database = {
    q(sql) { return {
      async get(...args) {
        if (sql.includes('FROM users')) return { id: args[0] };
        if (sql.includes('FROM products p')) return products.get(args[0]);
        if (sql.includes('FROM seller_profiles')) return { commission_bps: 0, status: 'APPROVED' };
        return undefined;
      },
      async all(...args) {
        if (sql.includes('UPDATE products SET stock=stock-')) {
          const product = products.get(args[1]);
          if (!product || product.stock < args[0]) return [];
          product.stock -= args[0];
          return [{ id: product.id }];
        }
        if (sql.includes('UPDATE coupons')) return [{ code: 'SAVE' }];
        return [];
      },
      async run(...args) {
        if (sql.includes('INSERT INTO seller_orders')) sellerOrders.push(args);
        return { changes: 1, rows: [] };
      }
    }; },
    async tx(fn) { return fn(); }
  };
  const checkout = createPostgresCheckoutRepository(database, {
    id: (() => { let n = 0; return () => 'id-' + (++n); })(),
    now: () => '2026-11-04T12:00:00.000Z',
    shippingFor: async () => 0,
    couponFor: async () => ({ code: 'SAVE', discount: 501 })
  });
  const result = await checkout.checkout({ id: 'buyer-1' }, {
    coupon_code: 'SAVE',
    delivery: { name: 'Buyer', phone: '01712345678', address: 'Road 1', area: 'Dhaka' },
    items: [{ productId: 'p-b', quantity: 1 }, { productId: 'p-a', quantity: 1 }]
  });
  assert.equal(result.discount_bdt, 5.01);
  assert.equal(sellerOrders.length, 2);
  const shares = Object.fromEntries(sellerOrders.map(row => [row[2], row[8]]));
  assert.deepEqual(shares, { 'seller-a': 250, 'seller-b': 251 });
  assert.equal(Object.values(shares).reduce((sum, value) => sum + value, 0), 501);
});
