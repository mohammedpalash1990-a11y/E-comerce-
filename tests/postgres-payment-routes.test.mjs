import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresPaymentRepository,
  registerPostgresPaymentRoutes
} from '../apps/api/src/postgres-payment-routes.mjs';
import { signCallback, verifySignature } from '../apps/api/src/gateways.mjs';

function paymentHarness({
  orderStatus = 'AWAITING_PAYMENT',
  orderPaymentStatus = 'PENDING',
  paymentStatus = 'PENDING',
  method = 'BKASH',
  amount = 16000
} = {}) {
  const state = {
    order: { id: 'order-1', user_id: 'customer-1', total_paisa: amount, status: orderStatus, payment_status: orderPaymentStatus },
    payment: {
      id: 'payment-1', order_id: 'order-1', method, amount_paisa: amount,
      status: paymentStatus, gateway_txn_id: paymentStatus === 'INITIATED' ? 'SBX-BKASH-123' : null,
      raw: '{}', created_at: '2026-11-06T00:00:00.000Z'
    },
    sellerOrders: [{ seller_id: 'seller-1' }],
    transactions: [], events: [], audits: [], notifications: [], refunds: [],
    calls: [], transactionDepth: 0
  };
  const database = {
    q(sql) {
      return {
        async get(...args) {
          state.calls.push({ method: 'get', sql, args });
          if (sql.includes('FROM orders WHERE id=? AND user_id=?')) {
            return args[0] === state.order.id && args[1] === state.order.user_id ? { ...state.order } : undefined;
          }
          if (sql.includes('FROM payments WHERE order_id=? AND status IN')) {
            return state.payment && state.payment.order_id === args[0] &&
              ['PENDING', 'INITIATING', 'INITIATED'].includes(state.payment.status)
              ? { ...state.payment } : undefined;
          }
          if (sql.includes('FROM payments p JOIN orders o')) {
            const byTransaction = sql.includes('WHERE p.method=? AND p.gateway_txn_id=?');
            if (byTransaction) {
              if (state.payment?.method !== args[0] || state.payment?.gateway_txn_id !== args[1]) return undefined;
            } else if (state.payment?.id !== args[0] || state.order.user_id !== args[1]) return undefined;
            return {
              ...state.payment, user_id: state.order.user_id,
              order_status: state.order.status, payment_status: state.order.payment_status,
              total_paisa: state.order.total_paisa
            };
          }
          if (sql.includes('COALESCE(SUM(amount_paisa),0) AS amount FROM refunds')) {
            return { amount: state.refunds.filter(x => x.status !== 'REJECTED').reduce((sum, x) => sum + x.amount_paisa, 0) };
          }
          return undefined;
        },
        async all(...args) {
          state.calls.push({ method: 'all', sql, args });
          if (sql.includes("UPDATE payments SET status='INITIATING'")) {
            if (!state.payment || state.payment.status !== 'PENDING') return [];
            state.payment.status = 'INITIATING';
            return [{ id: state.payment.id }];
          }
          if (sql.includes("UPDATE payments SET status='INITIATED'")) {
            if (!state.payment || state.payment.status !== 'INITIATING') return [];
            state.payment.gateway_txn_id = args[0];
            state.payment.raw = args[1];
            state.payment.updated_at = args[2];
            state.payment.status = 'INITIATED';
            return [{ id: state.payment.id }];
          }
          if (sql.includes('SELECT seller_id FROM seller_orders')) return state.sellerOrders.map(x => ({ ...x }));
          return [];
        },
        async run(...args) {
          state.calls.push({ method: 'run', sql, args });
          if (sql.includes('INSERT INTO payments')) {
            state.payment = {
              id: args[0], order_id: args[1], method: args[2], amount_paisa: args[3],
              status: args[4], gateway_txn_id: args[5], raw: args[6], created_at: args[7], updated_at: args[8]
            };
          } else if (sql.includes("UPDATE payments SET status='PENDING'")) {
            if (state.payment?.id === args[1] && ['INITIATING', 'PENDING'].includes(state.payment.status)) {
              state.payment.status = 'PENDING';
              state.payment.updated_at = args[0];
            }
          } else if (sql.includes('UPDATE payments SET method=')) {
            state.payment.method = args[0];
          } else if (sql.includes("UPDATE payments SET status='FAILED'")) {
            state.payment.status = 'FAILED';
          } else if (sql.includes("UPDATE payments SET status='PAID'")) {
            state.payment.status = 'PAID';
          } else if (sql.includes("UPDATE orders SET payment_method=")) {
            state.order.payment_method = args[0];
          } else if (sql.includes("UPDATE orders SET payment_status='PAID'")) {
            state.order.payment_status = 'PAID';
          } else if (sql.includes("UPDATE orders SET status='CONFIRMED'")) {
            state.order.status = 'CONFIRMED';
          } else if (sql.includes('UPDATE seller_orders SET status=')) {
            // A single test seller order is sufficient to verify the state transition.
            state.sellerOrders.forEach(row => { row.status = 'CONFIRMED'; });
          } else if (sql.includes('INSERT INTO transactions')) {
            state.transactions.push({ id: args[0], kind: args[1], order_id: args[2], amount_paisa: args[5], ref: args[6] });
          } else if (sql.includes('INSERT INTO order_events')) {
            state.events.push({ status: args[3], note: args[4] });
          } else if (sql.includes('INSERT INTO audit_logs')) {
            state.audits.push({ action: args[2], entity_id: args[4] });
          } else if (sql.includes('INSERT INTO notifications')) {
            state.notifications.push({ user_id: args[1], title: args[2] });
          } else if (sql.includes('INSERT INTO refunds')) {
            state.refunds.push({ amount_paisa: args[2], status: args[4] });
          }
          return { changes: 1, rows: [] };
        }
      };
    },
    async tx(fn) {
      state.transactionDepth++;
      state.calls.push({ method: 'tx', sql: 'BEGIN' });
      try {
        const value = await fn();
        state.calls.push({ method: 'tx', sql: 'COMMIT' });
        return value;
      } catch (error) {
        state.calls.push({ method: 'tx', sql: 'ROLLBACK' });
        throw error;
      } finally {
        state.transactionDepth--;
      }
    }
  };
  const repository = createPostgresPaymentRepository(database, {
    id: (() => { let n = 0; return () => 'generated-' + (++n); })(),
    now: () => '2026-11-06T01:00:00.000Z',
    gatewayInitiate: async (gatewayMethod, payment) => {
      assert.equal(state.transactionDepth, 0, 'the external gateway call must not run inside a database transaction');
      return {
        gatewayTxnId: 'SBX-' + gatewayMethod + '-new',
        redirectUrl: '/api/v1/payments/sandbox/' + payment.id,
        sandbox: true
      };
    }
  });
  return { state, database, repository };
}

function routeHarness({ paymentMode = 'sandbox', paymentRepository } = {}) {
  const routes = [];
  registerPostgresPaymentRoutes(
    (method, path, roles, handler) => routes.push({ method, path, roles, handler }),
    (data, status = 200) => ({ status, body: { data } }),
    { paymentRepository, paymentMode, gatewaySign: signCallback, gatewayVerify: verifySignature }
  );
  return {
    routes,
    find(method, path) {
      const route = routes.find(item => item.method === method && item.path === path);
      assert.ok(route, 'missing route ' + method + ' ' + path);
      return route;
    }
  };
}

test('PostgreSQL payment routes are customer-scoped except for the signed gateway callback', () => {
  const mock = {
    async prepareCustomerPayment() { return { id: 'payment-1', method: 'BKASH' }; },
    async initiatePayment() { return { id: 'payment-1', status: 'INITIATED' }; },
    async getCustomerPayment() { return null; },
    async recordVerifiedPaymentCallback() { return { duplicate: false, status: 'PAID' }; }
  };
  const h = routeHarness({ paymentRepository: mock });
  assert.deepEqual(h.find('POST', '/api/v1/customer/orders/:id/pay').roles, ['CUSTOMER']);
  assert.deepEqual(h.find('GET', '/api/v1/payments/:id/status').roles, ['CUSTOMER']);
  assert.deepEqual(h.find('POST', '/api/v1/payments/sandbox/:id/simulate').roles, ['CUSTOMER']);
  assert.equal(h.find('POST', '/api/v1/payments/callback/:gateway').roles, null);
});

test('payment initiation starts only for the order owner and returns the gateway reference', async () => {
  const calls = [];
  const h = routeHarness({
    paymentRepository: {
      async prepareCustomerPayment(input) { calls.push(['prepare', input]); return { id: 'payment-1', method: 'BKASH' }; },
      async initiatePayment(input) { calls.push(['initiate', input]); return { id: 'payment-1', status: 'INITIATED', gateway_txn_id: 'SBX-BKASH-1' }; },
      async getCustomerPayment() { return null; },
      async recordVerifiedPaymentCallback() { return { duplicate: false, status: 'PAID' }; }
    }
  });
  const out = await h.find('POST', '/api/v1/customer/orders/:id/pay').handler({
    user: { id: 'customer-1' }, params: ['order-1'], body: { method: 'BKASH' }
  });
  assert.equal(out.status, 201);
  assert.equal(out.body.data.status, 'INITIATED');
  assert.deepEqual(calls, [
    ['prepare', { userId: 'customer-1', orderId: 'order-1', method: 'BKASH' }],
    ['initiate', { userId: 'customer-1', paymentId: 'payment-1', method: 'BKASH' }]
  ]);
});

test('payment status endpoint returns only the owned payment summary', async () => {
  const h = routeHarness({
    paymentRepository: {
      async prepareCustomerPayment() {},
      async initiatePayment() {},
      async getCustomerPayment(userId, paymentId) {
        assert.equal(userId, 'customer-1');
        assert.equal(paymentId, 'payment-1');
        return { id: paymentId, method: 'BKASH', status: 'INITIATED', amount_paisa: 12550, gateway_txn_id: 'secret', raw: '{"private":true}' };
      },
      async recordVerifiedPaymentCallback() {}
    }
  });
  const out = await h.find('GET', '/api/v1/payments/:id/status').handler({
    user: { id: 'customer-1' }, params: ['payment-1']
  });
  assert.deepEqual(out.body.data, { id: 'payment-1', method: 'BKASH', status: 'INITIATED', amount_bdt: 125.5 });
});

test('gateway callback rejects malformed amounts and invalid signatures before database work', async () => {
  let calls = 0;
  const h = routeHarness({
    paymentRepository: {
      async prepareCustomerPayment() {},
      async initiatePayment() {},
      async getCustomerPayment() {},
      async recordVerifiedPaymentCallback() { calls++; return { duplicate: false, status: 'PAID' }; }
    }
  });
  const handler = h.find('POST', '/api/v1/payments/callback/:gateway').handler;
  const badAmount = { gateway_txn_id: 'SBX-BKASH-1', amount_bdt: '12.345', status: 'SUCCESS', signature: 'x' };
  await assert.rejects(handler({ params: ['BKASH'], body: badAmount }), error => error.status === 400);
  const badSignature = { gateway_txn_id: 'SBX-BKASH-1', amount_bdt: '12.35', status: 'SUCCESS', signature: 'x' };
  await assert.rejects(handler({ params: ['BKASH'], body: badSignature }), error => error.status === 401);
  await assert.rejects(handler({ params: ['COD'], body: badSignature }), error => error.status === 404);
  assert.equal(calls, 0);
});

test('signed gateway callback converts decimal BDT exactly to paisa and delegates once', async () => {
  let called;
  const h = routeHarness({
    paymentRepository: {
      async prepareCustomerPayment() {},
      async initiatePayment() {},
      async getCustomerPayment() {},
      async recordVerifiedPaymentCallback(input) { called = input; return { duplicate: false, status: 'PAID' }; }
    }
  });
  const signed = { gatewayTxnId: 'SBX-BKASH-123', amountPaisa: 12050, status: 'SUCCESS' };
  const result = await h.find('POST', '/api/v1/payments/callback/:gateway').handler({
    params: ['BKASH'],
    body: {
      gateway_txn_id: signed.gatewayTxnId,
      amount_bdt: '120.50',
      status: signed.status,
      signature: signCallback(signed)
    }
  });
  assert.deepEqual(called, { method: 'BKASH', gatewayTxnId: 'SBX-BKASH-123', amountPaisa: 12050, status: 'SUCCESS' });
  assert.equal(result.body.data.status, 'PAID');
});

test('sandbox simulation is owner-scoped, accepts only initiated payments and signs its callback', async () => {
  let callback;
  const h = routeHarness({
    paymentRepository: {
      async prepareCustomerPayment() {},
      async initiatePayment() {},
      async getCustomerPayment(userId) {
        assert.equal(userId, 'customer-1');
        return { id: 'payment-1', method: 'BKASH', status: 'INITIATED', amount_paisa: 9900, gateway_txn_id: 'SBX-BKASH-9' };
      },
      async recordVerifiedPaymentCallback(input) { callback = input; return { duplicate: false, status: 'PAID' }; }
    }
  });
  const result = await h.find('POST', '/api/v1/payments/sandbox/:id/simulate').handler({
    user: { id: 'customer-1' }, params: ['payment-1'], body: { outcome: 'success' }
  });
  assert.deepEqual(callback, { method: 'BKASH', gatewayTxnId: 'SBX-BKASH-9', amountPaisa: 9900, status: 'SUCCESS' });
  assert.equal(result.body.data.sandbox, true);
  await assert.rejects(h.find('POST', '/api/v1/payments/sandbox/:id/simulate').handler({
    user: { id: 'customer-1' }, params: ['payment-1'], body: { outcome: 'again' }
  }), error => error.status === 400);
});

test('live gateway callbacks and sandbox simulation are fail-closed outside sandbox mode', async () => {
  const mock = {
    async prepareCustomerPayment() {},
    async initiatePayment() {},
    async getCustomerPayment() { return { id: 'payment-1', method: 'BKASH', status: 'INITIATED', amount_paisa: 100, gateway_txn_id: 'txn' }; },
    async recordVerifiedPaymentCallback() {}
  };
  const h = routeHarness({ paymentRepository: mock, paymentMode: 'live' });
  await assert.rejects(h.find('POST', '/api/v1/payments/callback/:gateway').handler({
    params: ['BKASH'], body: {}
  }), error => error.status === 501);
  await assert.rejects(h.find('POST', '/api/v1/payments/sandbox/:id/simulate').handler({
    user: { id: 'customer-1' }, params: ['payment-1'], body: { outcome: 'success' }
  }), error => error.status === 404);
});

test('payment repository creates the payment intent and persists initiation after the gateway returns', async () => {
  const h = paymentHarness();
  const pending = await h.repository.prepareCustomerPayment({
    userId: 'customer-1', orderId: 'order-1', method: 'BKASH'
  });
  assert.equal(pending.id, 'payment-1');
  const result = await h.repository.initiatePayment({
    userId: 'customer-1', paymentId: pending.id, method: pending.method, amountPaisa: 16000
  });
  assert.equal(result.status, 'INITIATED');
  assert.equal(result.gateway_txn_id, 'SBX-BKASH-new');
  assert.equal(result.redirect_url, '/api/v1/payments/sandbox/payment-1/simulate');
  assert.equal(h.state.payment.status, 'INITIATED');
  assert.equal(h.state.payment.gateway_txn_id, 'SBX-BKASH-new');
});

test('verified payment callback is amount-bound, atomic and idempotent', async () => {
  const h = paymentHarness({ paymentStatus: 'INITIATED' });
  const first = await h.repository.recordVerifiedPaymentCallback({
    method: 'BKASH', gatewayTxnId: 'SBX-BKASH-123', amountPaisa: 16000, status: 'SUCCESS'
  });
  assert.deepEqual(first, { duplicate: false, status: 'PAID' });
  assert.equal(h.state.payment.status, 'PAID');
  assert.equal(h.state.order.payment_status, 'PAID');
  assert.equal(h.state.order.status, 'CONFIRMED');
  assert.equal(h.state.transactions.length, 1);
  assert.equal(h.state.events.some(event => event.status === 'PAYMENT_CONFIRMED'), true);
  assert.equal(h.state.audits.some(event => event.action === 'PAYMENT_PAID'), true);
  const duplicate = await h.repository.recordVerifiedPaymentCallback({
    method: 'BKASH', gatewayTxnId: 'SBX-BKASH-123', amountPaisa: 16000, status: 'SUCCESS'
  });
  assert.deepEqual(duplicate, { duplicate: true, status: 'PAID' });
  assert.equal(h.state.transactions.length, 1, 'duplicate callbacks must not duplicate the ledger');
});

test('verified amount mismatch cannot change payment or order state', async () => {
  const h = paymentHarness({ paymentStatus: 'INITIATED' });
  await assert.rejects(h.repository.recordVerifiedPaymentCallback({
    method: 'BKASH', gatewayTxnId: 'SBX-BKASH-123', amountPaisa: 15999, status: 'SUCCESS'
  }), error => error.status === 400);
  assert.equal(h.state.payment.status, 'INITIATED');
  assert.equal(h.state.order.payment_status, 'PENDING');
  assert.equal(h.state.transactions.length, 0);
});

test('failed callback cannot later be replayed as successful', async () => {
  const h = paymentHarness({ paymentStatus: 'INITIATED' });
  const failed = await h.repository.recordVerifiedPaymentCallback({
    method: 'BKASH', gatewayTxnId: 'SBX-BKASH-123', amountPaisa: 16000, status: 'FAILED'
  });
  assert.deepEqual(failed, { duplicate: false, status: 'FAILED' });
  const duplicate = await h.repository.recordVerifiedPaymentCallback({
    method: 'BKASH', gatewayTxnId: 'SBX-BKASH-123', amountPaisa: 16000, status: 'FAILED'
  });
  assert.deepEqual(duplicate, { duplicate: true, status: 'FAILED' });
  await assert.rejects(h.repository.recordVerifiedPaymentCallback({
    method: 'BKASH', gatewayTxnId: 'SBX-BKASH-123', amountPaisa: 16000, status: 'SUCCESS'
  }), error => error.status === 409);
  assert.equal(h.state.transactions.length, 0);
});

test('payment received after order cancellation creates a bounded refund request', async () => {
  const h = paymentHarness({ orderStatus: 'CANCELLED', paymentStatus: 'INITIATED' });
  const result = await h.repository.recordVerifiedPaymentCallback({
    method: 'BKASH', gatewayTxnId: 'SBX-BKASH-123', amountPaisa: 16000, status: 'SUCCESS'
  });
  assert.deepEqual(result, { duplicate: false, status: 'PAID' });
  assert.equal(h.state.order.status, 'CANCELLED', 'late payment must not reopen a cancelled order');
  assert.equal(h.state.refunds.length, 1);
  assert.equal(h.state.refunds[0].amount_paisa, 16000);
  assert.equal(h.state.refunds[0].status, 'REQUESTED');
});
