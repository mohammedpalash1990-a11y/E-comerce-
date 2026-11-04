import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresCustomerOrderRoutes } from '../apps/api/src/postgres-customer-order-routes.mjs';

const user = { id: 'buyer-1', role: 'CUSTOMER' };
const order = {
  id: 'order-1', user_id: user.id, status: 'PROCESSING', total_paisa: 11025,
  subtotal_paisa: 10025, shipping_paisa: 1500, discount_paisa: 500, coupon_code: 'TEST',
  payment_method: 'COD', payment_status: 'PENDING', created_at: '2026-11-04T00:00:00Z',
  delivery_name: 'ক্রেতা', delivery_phone: '01700000003', delivery_address: 'পরীক্ষার ঠিকানা',
  delivery_area: 'Dhaka', customer_note: 'Call on arrival', admin_note: 'PRIVATE ADMIN NOTE'
};
function setup({ found = order, empty = false, failItems = false } = {}) {
  const routes = [], calls = [];
  const database = {
    async tx(fn) {
      calls.push({ sql: 'BEGIN' });
      try { const result = await fn(); calls.push({ sql: 'COMMIT' }); return result; }
      catch (error) { calls.push({ sql: 'ROLLBACK' }); throw error; }
    },
    q(sql) { return {
      async run(...args) { calls.push({ sql, args }); },
      async get(...args) { calls.push({ sql, args }); return found; },
      async all(...args) {
        calls.push({ sql, args });
        if (empty) return [];
        if (sql.includes('FROM order_items')) {
          if (failItems) throw new Error('database unavailable');
          return [{ product_id: 'p1', product_name_bn: 'চা', quantity: '2', unit_price_paisa: '5012',
            variant: 'Large', seller_order_id: 'so1', private_cost: 123 }];
        }
        if (sql.includes('FROM seller_orders')) return [
          { id: 'so1', status: 'SHIPPED', subtotal_paisa: 10025, shop_name: 'Tea Shop',
            provider: 'test-courier', tracking_id: 'TEST-1', shipment_status: 'IN_TRANSIT', mode: 'sandbox', commission_paisa: 800 },
          { id: 'so2', status: 'PROCESSING', subtotal_paisa: 0, shop_name: null, tracking_id: null }
        ];
        if (sql.includes('FROM order_events')) return [{ status: 'CONFIRMED', created_at: order.created_at,
          seller_order_id: null, note: 'PRIVATE EVENT NOTE', actor_id: 'admin-private' }];
        if (sql.includes('FROM shipments')) return [{ seller_order_id: 'so1', provider: 'test-courier', tracking_id: 'TEST-1',
          shipment_status: 'IN_TRANSIT', mode: 'sandbox', charge_paisa: 999 }];
        throw new Error('Unexpected query: ' + sql);
      }
    }; }
  };
  registerPostgresCustomerOrderRoutes((method, path, roles, handler) => routes.push({ method, path, roles, handler }),
    data => ({ data }), { database });
  return { routes, calls, invoke: (tracking = false) => routes[tracking ? 1 : 0].handler({ user, params: ['order-1'] }) };
}

test('customer order routes declare CUSTOMER-only GET access and require transactions', () => {
  const { routes } = setup();
  assert.deepEqual(routes.map(({ method, path, roles }) => ({ method, path, roles })), [
    { method: 'GET', path: '/api/v1/customer/orders/:id', roles: ['CUSTOMER'] },
    { method: 'GET', path: '/api/v1/customer/orders/:id/tracking', roles: ['CUSTOMER'] }
  ]);
  assert.throws(() => registerPostgresCustomerOrderRoutes(() => {}, () => {}, { database: { q() {} } }), /transactions/);
});

test('order detail uses a consistent owner-scoped snapshot and explicit BDT customer projections', async () => {
  const h = setup();
  const { data } = await h.invoke();
  assert.equal(h.calls[0].sql, 'BEGIN');
  assert.equal(h.calls[1].sql, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.match(h.calls[2].sql, /FROM orders WHERE id=\? AND user_id=\?/);
  assert.deepEqual(h.calls[2].args, ['order-1', 'buyer-1']);
  assert.equal(h.calls.at(-1).sql, 'COMMIT');
  for (const call of h.calls.slice(3, -1)) assert.deepEqual(call.args, ['order-1']);
  assert.equal(data.orderNumber, 'HAAT-ORDER1');
  assert.equal(data.total_bdt, 110.25);
  assert.equal(data.shipping_bdt, 15);
  assert.equal(data.discount_bdt, 5);
  assert.equal(data.delivery.note, 'Call on arrival');
  assert.deepEqual(data.items, [{ product_id: 'p1', name_bn: 'চা', quantity: 2, unit_price_bdt: 50.12,
    variant: 'Large', seller_order_id: 'so1' }]);
  assert.deepEqual(data.suborders[0], { id: 'so1', shop: 'Tea Shop', status: 'SHIPPED', subtotal_bdt: 100.25,
    shipment: { provider: 'test-courier', tracking_id: 'TEST-1', status: 'IN_TRANSIT', mode: 'sandbox' } });
  assert.equal(data.suborders[1].shipment, null);
  assert.doesNotMatch(JSON.stringify(data), /admin_note|PRIVATE|commission|private_cost|user_id/);
  assert.match(h.calls[4].sql, /ORDER BY created_at DESC,id DESC LIMIT 1/);
});

test('tracking returns stable event and shipment projections without operational or financial secrets', async () => {
  const h = setup();
  const { data } = await h.invoke(true);
  assert.deepEqual(data, { orderNumber: 'HAAT-ORDER1', status: 'PROCESSING',
    events: [{ status: 'CONFIRMED', created_at: order.created_at, seller_order_id: null }],
    shipments: [{ seller_order_id: 'so1', provider: 'test-courier', tracking_id: 'TEST-1', status: 'IN_TRANSIT', mode: 'sandbox' }] });
  assert.match(h.calls[3].sql, /ORDER BY created_at,id/);
  assert.match(h.calls[4].sql, /WHERE so.order_id=\? ORDER BY s.created_at,s.id/);
  assert.doesNotMatch(JSON.stringify(data), /note|actor_id|charge|delivery|commission|gateway/);
});

for (const tracking of [false, true]) {
  test(`${tracking ? 'tracking' : 'detail'} refuses missing/foreign orders before querying children`, async () => {
    const denied = setup({ found: null });
    await assert.rejects(denied.invoke(tracking), error => error.status === 404 && error.message === 'Order not found');
    assert.equal(denied.calls.length, 4);
    assert.equal(denied.calls.at(-1).sql, 'ROLLBACK');
    assert.ok(!denied.calls.some(call => /FROM order_items|FROM seller_orders|FROM shipments|FROM order_events/.test(call.sql)));
  });
}

test('orders with no child rows return empty collections, not invented fulfilment', async () => {
  const h = setup({ empty: true });
  const detail = (await h.invoke()).data;
  assert.deepEqual(detail.items, []);
  assert.deepEqual(detail.suborders, []);
  const tracking = (await h.invoke(true)).data;
  assert.deepEqual(tracking.events, []);
  assert.deepEqual(tracking.shipments, []);
});

test('query failures roll back the read snapshot instead of returning partial data', async () => {
  const h = setup({ failItems: true });
  await assert.rejects(h.invoke(), /database unavailable/);
  assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(!h.calls.some(call => call.sql === 'COMMIT'));
});
