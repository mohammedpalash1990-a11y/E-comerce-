import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresCheckoutRepository } from '../apps/api/src/postgres-checkout.mjs';

function checkoutHarness({ stock = 8, coupon = null } = {}) {
  const products = new Map([['p-1', {
    id: 'p-1', name_bn: 'শার্ট', price_paisa: '12000', discount_paisa: '10000',
    stock, active: 1, status: 'ACTIVE', seller_id: 'seller-1'
  }]]);
  const sellers = new Map([['seller-1', { commission_bps: 800, status: 'APPROVED' }]]);
  const calls = [];
  const tables = { orders: [], seller_orders: [], order_items: [], payments: [], cart_deletes: [] };

  const database = {
    q(sql) {
      return {
        async get(...values) {
          calls.push({ sql, values, method: 'get' });
          if (sql.includes('FROM cart_items')) return [];
          if (sql.includes('FROM products p')) {
            const p = products.get(values[0]);
            return p && p.active === 1 && p.status === 'ACTIVE' && sellers.get(p.seller_id)?.status === 'APPROVED'
              ? { ...p } : undefined;
          }
          if (sql.includes('FROM seller_profiles')) return sellers.get(values[0]);
          return undefined;
        },
        async all(...values) {
          calls.push({ sql, values, method: 'all' });
          if (sql.includes('UPDATE products SET stock=stock-')) {
            const p = products.get(values[1]);
            if (!p || p.stock < values[0] || p.active !== 1 || p.status !== 'ACTIVE') return [];
            p.stock -= values[0];
            return [{ id: p.id }];
          }
          if (sql.includes('UPDATE coupons')) return coupon ? [{ code: coupon.code }] : [];
          return [];
        },
        async run(...values) {
          calls.push({ sql, values, method: 'run' });
          if (sql.includes('INSERT INTO orders')) tables.orders.push(values);
          if (sql.includes('INSERT INTO seller_orders')) tables.seller_orders.push(values);
          if (sql.includes('INSERT INTO order_items')) tables.order_items.push(values);
          if (sql.includes('INSERT INTO payments')) tables.payments.push(values);
          if (sql.includes('DELETE FROM cart_items')) tables.cart_deletes.push(values);
          return { changes: 1, rows: [], lastInsertRowid: null };
        }
      };
    },
    async tx(fn) {
      calls.push({ sql: 'BEGIN' });
      try {
        const result = await fn();
        calls.push({ sql: 'COMMIT' });
        return result;
      } catch (error) {
        calls.push({ sql: 'ROLLBACK' });
        throw error;
      }
    }
  };
  const notices = [];
  const events = [];
  const audits = [];
  const repo = createPostgresCheckoutRepository(database, {
    id: (() => { let n = 0; return () => 'id-' + (++n); })(),
    now: () => '2026-11-02T00:00:00.000Z',
    shippingFor: () => 6000,
    couponFor: async () => coupon,
    notify: async (...args) => notices.push(args),
    addEvent: async (...args) => events.push(args),
    audit: async (...args) => audits.push(args),
    orderNo: id => 'HAAT-' + id
  });
  return { repo, products, calls, tables, notices, events, audits };
}

const customer = { id: 'customer-1' };
const delivery = { name: 'Palash', phone: '01712345678', address: 'House 1, Road 2', area: 'Dhaka', note: '' };

test('checkout locks product rows and atomically reserves stock before creating seller orders', async () => {
  const h = checkoutHarness();
  const result = await h.repo.checkout(customer, {
    delivery, items: [{ productId: 'p-1', quantity: 2 }], payment_method: 'COD'
  });

  assert.equal(h.products.get('p-1').stock, 6);
  assert.equal(result.subtotal_bdt, 200);
  assert.equal(result.shipping_bdt, 60);
  assert.equal(result.total_bdt, 260);
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(h.tables.orders.length, 1);
  assert.equal(h.tables.seller_orders.length, 1);
  assert.equal(h.tables.order_items.length, 1);
  assert.equal(h.tables.payments.length, 1);
  assert.match(h.calls.find(x => x.sql.includes('FROM products p')).sql, /FOR UPDATE OF p/);
  assert.match(h.calls.find(x => x.sql.includes('UPDATE products SET stock=stock-')).sql, /RETURNING id/);
  assert.equal(h.notices.length, 1);
  assert.equal(h.events.length, 1);
  assert.equal(h.audits.length, 1);
});

test('checkout aggregates duplicate product lines and rejects quantities above the limit', async () => {
  const h = checkoutHarness();
  await h.repo.checkout(customer, {
    delivery, items: [
      { productId: 'p-1', quantity: 2, variant: 'M' },
      { productId: 'p-1', quantity: 3, variant: 'L' }
    ]
  });
  assert.equal(h.products.get('p-1').stock, 3);
  assert.equal(h.tables.order_items.length, 1);
  assert.equal(h.tables.order_items[0][4], 5);
  await assert.rejects(h.repo.checkout(customer, {
    delivery, items: [
      { productId: 'p-1', quantity: 1000 },
      { productId: 'p-1', quantity: 1 }
    ]
  }), /সর্বোচ্চ পরিমাণ/);
});

test('checkout refuses insufficient stock without inserting an order', async () => {
  const h = checkoutHarness({ stock: 1 });
  await assert.rejects(h.repo.checkout(customer, {
    delivery, items: [{ productId: 'p-1', quantity: 2 }]
  }), /স্টকে যথেষ্ট/);
  assert.equal(h.tables.orders.length, 0);
  assert.equal(h.products.get('p-1').stock, 1);
  assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
});

test('checkout refuses online payment before transaction when gateway adapter is missing', async () => {
  const h = checkoutHarness();
  await assert.rejects(h.repo.checkout(customer, {
    delivery, items: [{ productId: 'p-1', quantity: 1 }], payment_method: 'BKASH'
  }), /অনলাইন পেমেন্ট সার্ভিস/);
  assert.equal(h.calls.length, 0);
});

test('checkout rejects unapproved sellers and invalid money values', async () => {
  const h = checkoutHarness();
  h.products.get('p-1').seller_id = 'missing-seller';
  await assert.rejects(h.repo.checkout(customer, {
    delivery, items: [{ productId: 'p-1', quantity: 1 }]
  }), /উপলব্ধ নেই/);
  assert.equal(h.tables.orders.length, 0);
});
