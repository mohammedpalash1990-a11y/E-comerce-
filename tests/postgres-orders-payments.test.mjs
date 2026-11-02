import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresOrdersPaymentsRepository } from '../apps/api/src/postgres-orders-payments.mjs';
import { createScriptedDatabase } from './postgres-domain-test-helpers.mjs';

test('verified payment callback is idempotent and creates one ledger transaction', async () => {
  let paymentStatus = 'INITIATED';
  let orderStatus = 'AWAITING_PAYMENT';
  let paymentLedgerWrites = 0;
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.includes('FROM payments p JOIN orders o')) {
      return { id: 'pay-1', order_id: 'order-1', user_id: 'buyer-1', method: 'BKASH', gateway_txn_id: 'gw-1',
        amount_paisa: 25000, status: paymentStatus, order_status: orderStatus, payment_status: 'PENDING', total_paisa: 25000 };
    }
    if (method === 'run' && sql.startsWith("UPDATE payments SET status='PAID'")) paymentStatus = 'PAID';
    if (method === 'run' && sql.startsWith("UPDATE orders SET status='CONFIRMED'")) orderStatus = 'CONFIRMED';
    if (method === 'run' && sql.startsWith('INSERT INTO transactions')) paymentLedgerWrites += 1;
    return method === 'all' ? [{ seller_id: 'seller-1' }] : { changes: 1 };
  });
  const repo = createPostgresOrdersPaymentsRepository(database);
  const payload = { method: 'BKASH', gatewayTxnId: 'gw-1', amountPaisa: 25000, status: 'SUCCESS' };
  assert.deepEqual(await repo.recordVerifiedPaymentCallback(payload), { duplicate: false, status: 'PAID' });
  assert.deepEqual(await repo.recordVerifiedPaymentCallback(payload), { duplicate: true, status: 'PAID' });
  assert.equal(paymentLedgerWrites, 1);
});

test('payment callback rejects an amount mismatch before any state mutation', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.includes('FROM payments p JOIN orders o')) {
      return { id: 'pay-1', order_id: 'order-1', user_id: 'buyer-1', method: 'NAGAD', gateway_txn_id: 'gw-2',
        amount_paisa: 10000, status: 'INITIATED', order_status: 'AWAITING_PAYMENT', payment_status: 'PENDING', total_paisa: 10000 };
    }
    return { changes: 1 };
  });
  const repo = createPostgresOrdersPaymentsRepository(database);
  await assert.rejects(repo.recordVerifiedPaymentCallback({
    method: 'NAGAD', gatewayTxnId: 'gw-2', amountPaisa: 9999, status: 'SUCCESS'
  }), error => error.code === 'AMOUNT_MISMATCH' && error.status === 400);
  assert.equal(database.calls.some(c => c.method === 'run'), false);
});

test('customer order lookup scopes by both order id and owner id', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.startsWith('SELECT * FROM orders WHERE id=? AND user_id=?')) return null;
    return [];
  });
  const repo = createPostgresOrdersPaymentsRepository(database);
  assert.equal(await repo.getCustomerOrder('buyer-a', 'order-private'), null);
  assert.deepEqual(database.calls[0].params, ['order-private', 'buyer-a']);
  assert.equal(database.calls.length, 1);
});

test('seller cancellation is rejected when seller does not own the sub-order', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.startsWith('SELECT * FROM seller_orders')) return null;
    return { changes: 1 };
  });
  const repo = createPostgresOrdersPaymentsRepository(database);
  await assert.rejects(repo.transitionSellerOrder({
    sellerId: 'seller-a', sellerOrderId: 'seller-order-b', nextStatus: 'CANCELLED'
  }), error => error.code === 'SELLER_ORDER_NOT_FOUND' && error.status === 404);
  assert.equal(database.calls.some(c => c.sql.startsWith('UPDATE products')), false);
});

test('failed payment callback is recorded only once', async () => {
  let paymentStatus = 'INITIATED';
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.includes('FROM payments p JOIN orders o')) {
      return { id: 'pay-1', order_id: 'order-1', user_id: 'buyer-1', method: 'ROCKET', gateway_txn_id: 'gw-3',
        amount_paisa: 9000, status: paymentStatus, order_status: 'AWAITING_PAYMENT', payment_status: 'PENDING', total_paisa: 9000 };
    }
    if (method === 'run' && sql.startsWith("UPDATE payments SET status='FAILED'")) paymentStatus = 'FAILED';
    return { changes: 1 };
  });
  const repo = createPostgresOrdersPaymentsRepository(database);
  const payload = { method: 'ROCKET', gatewayTxnId: 'gw-3', amountPaisa: 9000, status: 'FAILED' };
  assert.deepEqual(await repo.recordVerifiedPaymentCallback(payload), { duplicate: false, status: 'FAILED' });
  assert.deepEqual(await repo.recordVerifiedPaymentCallback(payload), { duplicate: true, status: 'FAILED' });
});


test('payment retry reuses a pending attempt for the same method', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.startsWith('SELECT id,status,payment_status,total_paisa,payment_method FROM orders')) {
      return { id: 'order-1', status: 'AWAITING_PAYMENT', payment_status: 'PENDING', total_paisa: 9000, payment_method: 'BKASH' };
    }
    if (method === 'get' && sql.startsWith('SELECT * FROM payments WHERE order_id=')) {
      return { id: 'payment-1', order_id: 'order-1', method: 'BKASH', amount_paisa: 9000, status: 'PENDING' };
    }
    return { changes: 1 };
  });
  const repo = createPostgresOrdersPaymentsRepository(database);
  const result = await repo.prepareCustomerPayment({ userId: 'buyer-1', orderId: 'order-1', method: 'BKASH' });
  assert.equal(result.id, 'payment-1');
  assert.equal(result.status, 'PENDING');
  assert.equal(database.calls.some(c => c.sql.startsWith('INSERT INTO payments')), false);
});

test('payment retry cannot start while an initiated gateway attempt is active', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.startsWith('SELECT id,status,payment_status,total_paisa,payment_method FROM orders')) {
      return { id: 'order-1', status: 'AWAITING_PAYMENT', payment_status: 'PENDING', total_paisa: 9000 };
    }
    if (method === 'get' && sql.startsWith('SELECT * FROM payments WHERE order_id=')) {
      return { id: 'payment-1', order_id: 'order-1', method: 'BKASH', amount_paisa: 9000, status: 'INITIATED' };
    }
    return { changes: 1 };
  });
  const repo = createPostgresOrdersPaymentsRepository(database);
  await assert.rejects(
    repo.prepareCustomerPayment({ userId: 'buyer-1', orderId: 'order-1', method: 'NAGAD' }),
    error => error.code === 'PAYMENT_ATTEMPT_ACTIVE' && error.status === 409
  );
  assert.equal(database.calls.some(c => c.sql.startsWith('INSERT INTO payments')), false);
});

test('payment retry supersedes an uninitiated pending method and creates a new attempt', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.startsWith('SELECT id,status,payment_status,total_paisa,payment_method FROM orders')) {
      return { id: 'order-1', status: 'AWAITING_PAYMENT', payment_status: 'PENDING', total_paisa: 9000 };
    }
    if (method === 'get' && sql.startsWith('SELECT * FROM payments WHERE order_id=')) {
      return { id: 'payment-old', order_id: 'order-1', method: 'BKASH', amount_paisa: 9000, status: 'PENDING', gateway_txn_id: null };
    }
    return { changes: 1 };
  });
  const repo = createPostgresOrdersPaymentsRepository(database, { createId: () => 'payment-new', clock: () => '2026-11-01T03:00:00.000Z' });
  const result = await repo.prepareCustomerPayment({ userId: 'buyer-1', orderId: 'order-1', method: 'NAGAD' });
  assert.equal(result.id, 'payment-new');
  assert.equal(result.method, 'NAGAD');
  assert.equal(database.calls.some(c => c.sql.startsWith("UPDATE payments SET status='SUPERSEDED'")), true);
  assert.equal(database.calls.some(c => c.sql.startsWith('INSERT INTO payments')), true);
});

test('customer cancellation verifies order ownership inside the transaction', async () => {
  const database = createScriptedDatabase(({ method, sql, params }) => {
    if (method === 'get' && sql.startsWith('SELECT id FROM orders WHERE id=? AND user_id=?')) return null;
    return { changes: 1 };
  });
  const repo = createPostgresOrdersPaymentsRepository(database);
  await assert.rejects(
    repo.cancelCustomerOrder({ userId: 'buyer-a', orderId: 'order-owned-by-buyer-b' }),
    error => error.code === 'ORDER_NOT_FOUND' && error.status === 404
  );
  assert.deepEqual(database.calls[0].params, ['order-owned-by-buyer-b', 'buyer-a']);
  assert.equal(database.calls.some(c => c.sql.startsWith('UPDATE seller_orders') || c.sql.startsWith('UPDATE products')), false);
});
