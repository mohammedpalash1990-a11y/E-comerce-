import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresSellerCourierRoutes } from '../apps/api/src/postgres-seller-courier-routes.mjs';

function harness({
  sellerStatus = 'APPROVED',
  accountStatus = 'ACTIVE',
  owned = true,
  orderStatus = 'PROCESSING',
  sellerOrderStatus = 'SHIPPED',
  shipment = null
} = {}) {
  const routes = [], calls = [];
  const state = {
    seller: { status: sellerStatus, account_status: accountStatus },
    sellerOrderStatus,
    order: {
      id: 'seller-order-1', order_id: 'parent-order-1', status: orderStatus,
      delivery_area: 'Dhaka', user_id: 'customer-1'
    },
    shipment: shipment ? { ...shipment } : null,
    events: [], audits: [], notifications: [],
    transactionDepth: 0
  };
  const database = {
    q(sql) {
      return {
        async get(...args) {
          calls.push({ method: 'get', sql, args });
          const normalizedSql = sql.replace(/\\s+/g, ' ');
          if (sql.includes('FROM seller_profiles sp JOIN users')) return state.seller;
          if (sql.includes('FROM seller_orders so JOIN orders o')) {
            return owned && args[0] === state.order.id && args[1] === 'seller-1'
              ? { ...state.order } : undefined;
          }
          if (sql.includes('FROM shipments WHERE seller_order_id=?')) {
            const row = state.shipment;
            return row && row.seller_order_id === args[0] &&
              !['FAILED_DELIVERY', 'RETURNED'].includes(row.status) ? { ...row } : undefined;
          }
          if (normalizedSql.includes('FROM shipments sh JOIN seller_orders so')) {
            const row = state.shipment;
            return row && row.id === args[0] && owned && args[1] === 'seller-1'
              ? {
                  ...row, order_id: state.order.order_id, seller_order_status: state.sellerOrderStatus,
                  user_id: state.order.user_id
                } : undefined;
          }
          return undefined;
        },
        async all(...args) {
          calls.push({ method: 'all', sql, args });
          if (sql.includes('UPDATE shipments SET status=?')) {
            if (!state.shipment || state.shipment.id !== args[1] || state.shipment.status !== args[2]) return [];
            state.shipment.status = args[0];
            return [{ id: state.shipment.id }];
          }
          return [];
        },
        async run(...args) {
          calls.push({ method: 'run', sql, args });
          if (sql.includes('INSERT INTO shipments')) {
            state.shipment = {
              id: args[0], seller_order_id: args[1], provider: args[2], tracking_id: args[3],
              status: args[4], charge_paisa: args[5], mode: args[6], created_at: args[7]
            };
          } else if (sql.includes('INSERT INTO order_events')) {
            state.events.push({ status: args[3], note: args[4] });
          } else if (sql.includes('INSERT INTO audit_logs')) {
            state.audits.push({ action: args[2], entity_id: args[4], detail: args[5] });
          } else if (sql.includes('INSERT INTO notifications')) {
            state.notifications.push({ user_id: args[1], title: args[2], body: args[3] });
          }
          return { changes: 1, rows: [] };
        }
      };
    },
    async tx(fn) {
      state.transactionDepth++;
      calls.push({ method: 'tx', sql: 'BEGIN' });
      try {
        const result = await fn();
        calls.push({ method: 'tx', sql: 'COMMIT' });
        return result;
      } catch (error) {
        calls.push({ method: 'tx', sql: 'ROLLBACK' });
        throw error;
      } finally {
        state.transactionDepth--;
      }
    }
  };
  const lifecycleCalls = [];
  const orderLifecycle = {
    async applySellerStatus(...args) {
      assert.equal(state.transactionDepth, 0, 'order lifecycle must run after the shipment transaction commits');
      lifecycleCalls.push(args);
      state.sellerOrderStatus = args[1];
      return 'DELIVERED';
    }
  };
  registerPostgresSellerCourierRoutes(
    (method, path, roles, handler) => routes.push({ method, path, roles, handler }),
    (data, status = 200) => ({ status, body: { data } }),
    { database, orderLifecycle, id: (() => { let n = 0; return () => 'generated-' + (++n); })(), now: () => '2026-11-06T02:00:00.000Z' }
  );
  const find = (method, path) => {
    const route = routes.find(item => item.method === method && item.path === path);
    assert.ok(route, 'missing ' + method + ' ' + path);
    return route;
  };
  return { routes, calls, state, lifecycleCalls, find, database };
}

const user = { id: 'seller-1', role: 'SELLER' };
const quoteUrl = new URL('https://shop.example/api/v1/seller/courier/quote?area=Dhaka');

test('seller courier routes are restricted to authenticated SELLER accounts', () => {
  const h = harness();
  assert.deepEqual(h.find('GET', '/api/v1/seller/courier/quote').roles, ['SELLER']);
  assert.deepEqual(h.find('POST', '/api/v1/seller/orders/:id/courier').roles, ['SELLER']);
  assert.deepEqual(h.find('POST', '/api/v1/seller/shipments/:id/status').roles, ['SELLER']);
});

test('courier quote exposes only supported providers and sandbox prices', async () => {
  const h = harness();
  const result = await h.find('GET', '/api/v1/seller/courier/quote').handler({ user, url: quoteUrl });
  assert.equal(result.body.data.mode, 'sandbox');
  assert.deepEqual(Object.keys(result.body.data.quotes_bdt).sort(), ['PATHAO', 'REDX', 'STEADFAST']);
  assert.ok(Object.values(result.body.data.quotes_bdt).every(value => Number.isFinite(value) && value >= 0));
});

test('unapproved or inactive sellers cannot request courier quotes or create shipments', async () => {
  for (const options of [{ sellerStatus: 'PENDING' }, { accountStatus: 'SUSPENDED' }]) {
    const h = harness(options);
    await assert.rejects(
      h.find('GET', '/api/v1/seller/courier/quote').handler({ user, url: quoteUrl }),
      error => error.status === 403
    );
    await assert.rejects(
      h.find('POST', '/api/v1/seller/orders/:id/courier').handler({ user, params: ['seller-order-1'], body: { provider: 'PATHAO' } }),
      error => error.status === 403
    );
    assert.equal(h.state.shipment, null);
  }
});

test('seller cannot book courier for another seller order', async () => {
  const h = harness({ owned: false });
  await assert.rejects(
    h.find('POST', '/api/v1/seller/orders/:id/courier').handler({ user, params: ['foreign-order'], body: { provider: 'PATHAO' } }),
    error => error.status === 404
  );
  assert.equal(h.state.shipment, null);
});

test('courier booking is atomic, ownership-scoped and idempotently rejects a second active shipment', async () => {
  const h = harness({ orderStatus: 'SHIPPED' });
  const result = await h.find('POST', '/api/v1/seller/orders/:id/courier').handler({
    user, params: ['seller-order-1'], body: { provider: 'PATHAO' }
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.data.status, 'BOOKED');
  assert.equal(result.body.data.provider, 'PATHAO');
  assert.equal(result.body.data.mode, 'sandbox');
  assert.match(result.body.data.tracking_id, /^PA-/);
  assert.equal(h.state.shipment.seller_order_id, 'seller-order-1');
  assert.equal(h.state.events[0].status, 'COURIER_BOOKED');
  assert.equal(h.state.audits[0].action, 'COURIER_BOOKED');
  assert.equal(h.state.notifications[0].user_id, 'customer-1');
  await assert.rejects(
    h.find('POST', '/api/v1/seller/orders/:id/courier').handler({
      user, params: ['seller-order-1'], body: { provider: 'REDX' }
    }),
    error => error.status === 409
  );
  assert.equal(h.state.audits.length, 1);
});

test('courier booking rejects unsupported providers and orders outside PROCESSING or SHIPPED', async () => {
  const invalid = harness();
  await assert.rejects(
    invalid.find('POST', '/api/v1/seller/orders/:id/courier').handler({
      user, params: ['seller-order-1'], body: { provider: 'UNKNOWN' }
    }),
    error => error.status === 400
  );
  const notReady = harness({ orderStatus: 'CONFIRMED' });
  await assert.rejects(
    notReady.find('POST', '/api/v1/seller/orders/:id/courier').handler({
      user, params: ['seller-order-1'], body: { provider: 'PATHAO' }
    }),
    error => error.status === 409
  );
});

test('shipment status only follows forward courier transitions and rejects foreign IDs', async () => {
  const h = harness({
    shipment: {
      id: 'shipment-1', seller_order_id: 'seller-order-1', provider: 'PATHAO',
      tracking_id: 'PA-123', status: 'BOOKED', mode: 'sandbox'
    }
  });
  const handler = h.find('POST', '/api/v1/seller/shipments/:id/status').handler;
  const picked = await handler({ user, params: ['shipment-1'], body: { status: 'PICKED_UP' } });
  assert.equal(picked.body.data.status, 'PICKED_UP');
  await assert.rejects(handler({ user, params: ['shipment-1'], body: { status: 'BOOKED' } }), error => error.status === 409);
  const foreign = harness({
    owned: false,
    shipment: {
      id: 'foreign-shipment', seller_order_id: 'seller-order-1', provider: 'PATHAO',
      tracking_id: 'PA-999', status: 'BOOKED', mode: 'sandbox'
    }
  });
  await assert.rejects(
    foreign.find('POST', '/api/v1/seller/shipments/:id/status').handler({
      user, params: ['foreign-shipment'], body: { status: 'PICKED_UP' }
    }),
    error => error.status === 404
  );
});

test('DELIVERED shipment commits first then uses the canonical order lifecycle for seller earnings', async () => {
  const h = harness({
    shipment: {
      id: 'shipment-1', seller_order_id: 'seller-order-1', provider: 'PATHAO',
      tracking_id: 'PA-123', status: 'IN_TRANSIT', mode: 'sandbox'
    },
    sellerOrderStatus: 'SHIPPED'
  });
  const result = await h.find('POST', '/api/v1/seller/shipments/:id/status').handler({
    user, params: ['shipment-1'], body: { status: 'DELIVERED' }
  });
  assert.equal(result.body.data.status, 'DELIVERED');
  assert.equal(result.body.data.parent_status, 'DELIVERED');
  assert.deepEqual(h.lifecycleCalls, [['seller-order-1', 'DELIVERED', 'seller-1', 'কুরিয়ার ডেলিভারি নিশ্চিত']]);
  assert.equal(h.state.audits[0].action, 'SHIPMENT_DELIVERED');
});

test('repeating DELIVERED safely retries a missed order lifecycle commit without duplicating shipment events', async () => {
  const h = harness({
    shipment: {
      id: 'shipment-1', seller_order_id: 'seller-order-1', provider: 'PATHAO',
      tracking_id: 'PA-123', status: 'DELIVERED', mode: 'sandbox'
    },
    sellerOrderStatus: 'SHIPPED'
  });
  const result = await h.find('POST', '/api/v1/seller/shipments/:id/status').handler({
    user, params: ['shipment-1'], body: { status: 'DELIVERED' }
  });
  assert.equal(result.body.data.duplicate, true);
  assert.equal(result.body.data.parent_status, 'DELIVERED');
  assert.equal(h.lifecycleCalls.length, 1);
  assert.equal(h.state.events.length, 0);
});


test('courier cannot be booked before the seller marks the sub-order SHIPPED', async () => {
  const h = harness({ orderStatus: 'PROCESSING' });
  await assert.rejects(
    h.find('POST', '/api/v1/seller/orders/:id/courier').handler({
      user, params: ['seller-order-1'], body: { provider: 'PATHAO' }
    }),
    error => error.status === 409
  );
  assert.equal(h.state.shipment, null);
});


test('courier status endpoint cannot be used to manufacture the initial BOOKED state', async () => {
  const h = harness({
    shipment: {
      id: 'shipment-1', seller_order_id: 'seller-order-1', provider: 'PATHAO',
      tracking_id: 'PA-123', status: 'BOOKED', mode: 'sandbox'
    }
  });
  await assert.rejects(
    h.find('POST', '/api/v1/seller/shipments/:id/status').handler({
      user, params: ['shipment-1'], body: { status: 'BOOKED' }
    }),
    error => error.status === 400
  );
});
