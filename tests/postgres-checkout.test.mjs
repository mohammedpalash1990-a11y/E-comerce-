import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresCheckoutRepository } from '../apps/api/src/postgres-checkout.mjs';
import { createScriptedDatabase } from './postgres-domain-test-helpers.mjs';

const product = { id: 'p-1', name_bn: 'চাল', price_paisa: 10000, discount_paisa: 8000, stock: 5, seller_id: 'seller-1', commission_bps: 800 };

test('addItem locks product and prevents cart quantity above available stock', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.includes('FROM products p JOIN seller_profiles')) return product;
    if (method === 'get' && sql.startsWith('SELECT quantity FROM cart_items')) return { quantity: 2 };
    if (method === 'all' && sql.includes('FROM cart_items ci')) return [];
    return { changes: 1 };
  });
  const repo = createPostgresCheckoutRepository(database, { shippingForPaisa: () => 6000 });
  await assert.rejects(repo.addItem('user-1', 'p-1', 4), error => error.code === 'INSUFFICIENT_STOCK' && error.status === 409);
  assert.equal(database.calls.some(c => c.sql.startsWith('INSERT INTO cart_items')), false);
});

test('checkout uses discounted paisa price, groups a seller order and reserves stock atomically', async () => {
  let stock = 5;
  const database = createScriptedDatabase(({ method, sql, params }) => {
    if (method === 'get' && sql.includes('FROM products p JOIN seller_profiles')) return product;
    if (method === 'get' && sql.startsWith('UPDATE products SET stock=stock-')) return { id: 'p-1', stock: stock -= params[0] };
    return method === 'all' ? [] : { changes: 1 };
  });
  const repo = createPostgresCheckoutRepository(database, {
    shippingForPaisa: (area, subtotal) => area === 'Dhaka' ? 6000 : 12000,
    createId: (() => { let n = 0; return () => 'id-' + (++n); })(),
    clock: () => '2026-11-01T01:00:00.000Z'
  });
  const result = await repo.checkout({
    userId: 'user-1',
    items: [{ productId: 'p-1', quantity: 2 }],
    delivery: { name: 'Buyer', phone: '01711111111', address: 'Road 1', area: 'Dhaka' },
    paymentMethod: 'COD'
  });
  assert.equal(result.subtotal_paisa, 16000);
  assert.equal(result.shipping_paisa, 6000);
  assert.equal(result.total_paisa, 22000);
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(stock, 3);
  assert.equal(database.transactionCount, 1);
  const sellerOrder = database.calls.find(c => c.sql.startsWith('INSERT INTO seller_orders'));
  assert.equal(sellerOrder.params[3], 'CONFIRMED');
  assert.equal(sellerOrder.params[4], 16000);
  const movement = database.calls.find(c => c.sql.startsWith('INSERT INTO inventory_movements'));
  assert.equal(movement.params[2], -2);
});

test('checkout rejects insufficient stock before writing order rows', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.includes('FROM products p JOIN seller_profiles')) return { ...product, stock: 1 };
    return method === 'all' ? [] : { changes: 1 };
  });
  const repo = createPostgresCheckoutRepository(database, { shippingForPaisa: () => 0 });
  await assert.rejects(repo.checkout({
    userId: 'user-1', items: [{ productId: 'p-1', quantity: 2 }],
    delivery: { name: 'Buyer', phone: '01711111111', address: 'Road 1', area: 'Dhaka' }
  }), error => error.code === 'INSUFFICIENT_STOCK');
  assert.equal(database.calls.some(c => c.sql.startsWith('INSERT INTO orders')), false);
});

test('online checkout leaves gateway initiation pending for the external gateway step', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.includes('FROM products p JOIN seller_profiles')) return product;
    if (method === 'get' && sql.startsWith('UPDATE products SET stock=stock-')) return { id: 'p-1', stock: 4 };
    return method === 'all' ? [] : { changes: 1 };
  });
  const repo = createPostgresCheckoutRepository(database, { shippingForPaisa: () => 0 });
  const result = await repo.checkout({
    userId: 'user-1', items: [{ productId: 'p-1', quantity: 1 }],
    delivery: { name: 'Buyer', phone: '01711111111', address: 'Road 1', area: 'Dhaka' },
    paymentMethod: 'BKASH'
  });
  assert.equal(result.status, 'AWAITING_PAYMENT');
  assert.equal(result.payment_status, 'PENDING');
  const payment = database.calls.find(c => c.sql.startsWith('INSERT INTO payments'));
  assert.equal(payment.params[4], 'PENDING');
  assert.equal(payment.params[5], null);
});

test('checkout requires a valid Bangladesh phone and an injected shipping quote', async () => {
  const database = createScriptedDatabase(() => null);
  const repo = createPostgresCheckoutRepository(database, { shippingForPaisa: () => 0 });
  await assert.rejects(repo.checkout({
    userId: 'user-1', items: [{ productId: 'p-1', quantity: 1 }],
    delivery: { name: 'Buyer', phone: '123', address: 'Road 1', area: 'Dhaka' }
  }), error => error.code === 'INVALID_PHONE');
  assert.throws(() => createPostgresCheckoutRepository(database), /shippingForPaisa/);
});
