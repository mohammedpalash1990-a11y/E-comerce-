import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresCheckoutRepository } from '../apps/api/src/postgres-checkout.mjs';

function checkoutHarness({ stock = 8, coupon = null, paymentMethods = ['COD'], shippingFor = () => 6000, cart = [], owner = true, initiatePayment } = {}) {
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
          if (sql.includes('FROM users')) return owner ? { id: values[0] } : undefined;
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
          if (sql.includes('FROM cart_items')) return cart;
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
    shippingFor,
    couponFor: async () => coupon,
    notify: async (...args) => notices.push(args),
    addEvent: async (...args) => events.push(args),
    audit: async (...args) => audits.push(args),
    paymentMethods,
    initiatePayment,
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
  const h = checkoutHarness({ paymentMethods: ['COD', 'BKASH'] });
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


test('checkout fails closed when no shipping policy is configured', async () => {
  const h = checkoutHarness({ shippingFor: null });
  await assert.rejects(h.repo.checkout(customer, {
    delivery, items: [{ productId: 'p-1', quantity: 1 }]
  }), error => error.status === 503 && /ডেলিভারি চার্জ নীতিমালা/.test(error.message));
  assert.equal(h.calls.length, 0);
  assert.equal(h.tables.orders.length, 0);
  assert.equal(h.products.get('p-1').stock, 8);
});


test('cart checkout locks the customer before reading a correctly quoted PostgreSQL productId alias', async () => {
  const h = checkoutHarness({ cart: [{ productId: 'p-1', quantity: 2 }] });
  await h.repo.checkout(customer, { delivery });
  assert.equal(h.calls[0].sql, 'BEGIN');
  assert.match(h.calls[1].sql, /FROM users.*FOR UPDATE/);
  assert.match(h.calls[2].sql, /SELECT product_id AS "productId",quantity/);
  assert.deepEqual(h.calls[2].values, [customer.id]);
  assert.equal(h.tables.order_items[0][4], 2);
  assert.deepEqual(h.tables.cart_deletes, [[customer.id]]);
});

test('checkout refuses inactive owners before reading or deleting their cart', async () => {
  const h = checkoutHarness({ owner: false });
  await assert.rejects(h.repo.checkout(customer, { delivery }), error => error.status === 401);
  assert.ok(!h.calls.some(call => call.sql.includes('FROM cart_items')));
  assert.deepEqual(h.tables.cart_deletes, []);
  assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
});

test('checkout records the validated coupon and server-calculated discount with usage in its transaction', async () => {
  const h = checkoutHarness({ coupon: { code: 'SAVE', discount: 2500 } });
  const result = await h.repo.checkout(customer, { delivery, items: [{ productId: 'p-1', quantity: 2 }], coupon_code: ' save ', discount_bdt: 9999 });
  assert.equal(result.discount_bdt, 25);
  assert.equal(result.total_bdt, 235);
  assert.equal(h.tables.orders[0][12], 2500);
  assert.equal(h.tables.orders[0][13], 'SAVE');
  const consume = h.calls.find(call => call.sql.includes('UPDATE coupons'));
  assert.deepEqual(consume.values, ['SAVE']);
  assert.match(consume.sql, /used_count<max_uses/);
  assert.equal(h.calls.at(-1).sql, 'COMMIT');
});

test('a requested coupon is never silently ignored when an injected validator returns no result', async () => {
  const h = checkoutHarness();
  await assert.rejects(h.repo.checkout(customer, { delivery, items: [{ productId: 'p-1', quantity: 1 }], coupon_code: 'SAVE' }), error => error.status === 503);
  assert.equal(h.tables.orders.length, 0);
  assert.equal(h.products.get('p-1').stock, 8);
  assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
});

test('no coupon is applied unless the customer supplied a code', async () => {
  const h = checkoutHarness({ coupon: { code: 'SAVE', discount: 2500 } });
  const result = await h.repo.checkout(customer, { delivery, items: [{ productId: 'p-1', quantity: 1 }] });
  assert.equal(result.discount_bdt, 0);
  assert.ok(!h.calls.some(call => call.sql.includes('UPDATE coupons')));
});


test('malformed injected coupon results cannot silently consume a code without a valid discount', async () => {
  for (const discount of [undefined, null, false, NaN, -1, '2500']) {
    const h = checkoutHarness({ coupon: { code: 'SAVE', discount } });
    await assert.rejects(h.repo.checkout(customer, { delivery, items: [{ productId: 'p-1', quantity: 1 }], coupon_code: 'SAVE' }), error => error.status === 503);
    assert.equal(h.products.get('p-1').stock, 8);
    assert.equal(h.tables.orders.length, 0);
    assert.ok(!h.calls.some(call => call.sql.includes('UPDATE coupons')));
  }
});


test('online checkout starts the gateway only after the stock/order transaction commits', async () => {
  const initiated = [];
  const h = checkoutHarness({
    paymentMethods: ['COD', 'BKASH'],
    initiatePayment: async input => {
      assert.equal(h.calls.at(-1).sql, 'COMMIT', 'external gateway must not run inside checkout transaction');
      initiated.push(input);
      return {
        id: input.paymentId, method: input.method, status: 'INITIATED',
        gateway_txn_id: 'SBX-BKASH-123', redirect_url: '/api/v1/payments/sandbox/' + input.paymentId + '/simulate',
        sandbox: true
      };
    }
  });
  const result = await h.repo.checkout(customer, {
    delivery, items: [{ productId: 'p-1', quantity: 1 }], payment_method: 'BKASH'
  });
  assert.equal(result.status, 'AWAITING_PAYMENT');
  assert.equal(result.payment.method, 'BKASH');
  assert.equal(result.payment.status, 'INITIATED');
  assert.equal(result.payment.sandbox, true);
  assert.equal(initiated.length, 1);
  assert.equal(initiated[0].userId, customer.id);
  assert.equal(initiated[0].method, 'BKASH');
  assert.equal(initiated[0].amountPaisa, 16000);
  assert.equal(initiated[0].paymentId, h.tables.payments[0][0]);
  assert.equal(h.tables.payments.length, 1, 'the pending payment row is retained for gateway initiation');
  assert.equal(h.calls.some(call => call.sql.includes('DELETE FROM payments')), false);
});
