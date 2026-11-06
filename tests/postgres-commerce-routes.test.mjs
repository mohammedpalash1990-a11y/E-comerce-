import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresCommerceRoutes } from '../apps/api/src/postgres-commerce-routes.mjs';

function setup({ ownedSellerOrder = true, customerOrder = true, sellerStatus = 'APPROVED' } = {}) {
  const routes = [];
  const calls = [];
  const database = {
    q(sql) {
      return {
        async get(...args) {
          calls.push({ sql, args, method: 'get' });
          if (sql.includes('FROM seller_profiles WHERE user_id=?')) return { status: sellerStatus };
          if (sql.includes('FROM seller_orders WHERE id=? AND seller_id=?')) return ownedSellerOrder ? { id: args[0] } : undefined;
          if (sql.includes('FROM orders WHERE id=? AND user_id=?')) return customerOrder ? { id: args[0] } : undefined;
          if (sql.includes('FROM orders WHERE id=?')) return { id: args[0] };
          return undefined;
        },
        async all(...args) {
          calls.push({ sql, args, method: 'all' });
          if (sql.includes('FROM seller_orders so') && sql.includes('LEFT JOIN LATERAL')) return [{
            id: 'seller-order-1', order_id: 'parent-order-1', status: 'PROCESSING',
            subtotal_paisa: 12000, commission_paisa: 960, net_paisa: 11040,
            created_at: '2026-11-06T00:00:00.000Z',
            customer_name: 'Buyer', customer_phone: '01700000000',
            delivery_name: 'Buyer', delivery_phone: '01700000000',
            delivery_address: 'Road 1', delivery_area: 'Dhaka', customer_note: 'Call first',
            items: [{ name_bn: 'চা', quantity: '2', unit_price_bdt: '60', variant: 'Large' }],
            shipment_id: 'shipment-1', shipment_provider: 'PATHAO', shipment_tracking_id: 'PA-123',
            shipment_status: 'BOOKED', shipment_mode: 'sandbox'
          }];
          return [];
        },
        async run(...args) { calls.push({ sql, args, method: 'run' }); return { changes: 1, rows: [] }; }
      };
    },
    async tx(fn) { return fn(); }
  };
  const checkoutRepository = { checkout: async (user, body) => ({ id: 'order-1', total_bdt: 120, status: 'CONFIRMED', user_id: user.id, submitted: body }) };
  const orderRepository = {
    applyParentStatus: async (...args) => { calls.push({ lifecycle: 'parent', args }); return args[1]; },
    applySellerStatus: async (...args) => { calls.push({ lifecycle: 'seller', args }); return 'PROCESSING'; }
  };
  registerPostgresCommerceRoutes((method, path, roles, handler) => routes.push({ method, path, roles, handler }), (data, status = 200) => ({ status, body: { data } }), {
    database, checkoutRepository, orderRepository
  });
  return { routes, calls };
}
const find = (h, method, path) => h.routes.find(r => r.method === method && r.path === path);

test('registers PostgreSQL-only customer, seller and admin commerce routes with role scopes', () => {
  const h = setup();
  assert.deepEqual(find(h, 'POST', '/api/v1/checkout').roles, ['CUSTOMER']);
  assert.deepEqual(find(h, 'GET', '/api/v1/customer/orders').roles, ['CUSTOMER']);
  assert.deepEqual(find(h, 'POST', '/api/v1/customer/orders/:id/cancel').roles, ['CUSTOMER']);
  assert.deepEqual(find(h, 'GET', '/api/v1/seller/orders').roles, ['SELLER']);
  assert.deepEqual(find(h, 'POST', '/api/v1/seller/orders/:id/status').roles, ['SELLER']);
  assert.deepEqual(find(h, 'GET', '/api/v1/admin/orders').roles, ['ADMIN']);
  assert.deepEqual(find(h, 'POST', '/api/v1/admin/orders/:id/status').roles, ['ADMIN']);
});

test('checkout delegates validated work to the transactional repository and returns 201', async () => {
  const h = setup();
  const response = await find(h, 'POST', '/api/v1/checkout').handler({ user: { id: 'customer-1' }, body: { items: [] } });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.id, 'order-1');
  assert.equal(response.body.data.orderNumber, 'HAAT-ORDER1');
});

test('customer cancellation is restricted to the authenticated customer order', async () => {
  const h = setup({ customerOrder: false });
  await assert.rejects(find(h, 'POST', '/api/v1/customer/orders/:id/cancel').handler({
    user: { id: 'customer-1' }, params: ['order-other'], body: {}
  }), error => error.status === 404);
  assert.equal(h.calls.some(x => x.lifecycle === 'parent'), false);
});

test('seller status update checks seller ownership before invoking lifecycle repository', async () => {
  const h = setup({ ownedSellerOrder: false });
  await assert.rejects(find(h, 'POST', '/api/v1/seller/orders/:id/status').handler({
    user: { id: 'seller-1' }, params: ['seller-order-other'], body: { status: 'PROCESSING' }
  }), error => error.status === 404);
  assert.equal(h.calls.some(x => x.lifecycle === 'seller'), false);
});

test('seller and admin transitions reject unsupported status values', async () => {
  const h = setup();
  await assert.rejects(find(h, 'POST', '/api/v1/seller/orders/:id/status').handler({
    user: { id: 'seller-1' }, params: ['seller-order-1'], body: { status: 'REFUNDED' }
  }), error => error.status === 400);
  await assert.rejects(find(h, 'POST', '/api/v1/admin/orders/:id/status').handler({
    user: { id: 'admin-1' }, params: ['order-1'], body: { status: 'HACKED' }
  }), error => error.status === 400);
  assert.equal(h.calls.some(x => x.lifecycle), false);
});

test('admin order status delegates only after the order exists', async () => {
  const h = setup();
  const response = await find(h, 'POST', '/api/v1/admin/orders/:id/status').handler({
    user: { id: 'admin-1' }, params: ['order-1'], body: { status: 'PROCESSING', note: 'checked' }
  });
  assert.equal(response.body.data.status, 'PROCESSING');
  assert.equal(h.calls.find(x => x.lifecycle === 'parent').args[0], 'order-1');
});


test('pending or suspended sellers cannot mutate order status', async () => {
  for (const sellerStatus of ['PENDING', 'SUSPENDED', 'REJECTED']) {
    const h = setup({ sellerStatus });
    await assert.rejects(find(h, 'POST', '/api/v1/seller/orders/:id/status').handler({
      user: { id: 'seller-1' }, params: ['seller-order-1'], body: { status: 'PROCESSING' }
    }), error => error.status === 403);
    assert.equal(h.calls.some(x => x.lifecycle === 'seller'), false);
  }
});


test('seller order list returns buyer, delivery, purchased items and current courier tracking data', async () => {
  const h = setup();
  const response = await find(h, 'GET', '/api/v1/seller/orders').handler({
    user: { id: 'seller-1' }, url: new URL('https://shop.example/api/v1/seller/orders')
  });
  const order = response.body.data[0];
  assert.equal(order.customer.name, 'Buyer');
  assert.equal(order.delivery.area, 'Dhaka');
  assert.equal(order.delivery.note, 'Call first');
  assert.deepEqual(order.items, [{ name_bn: 'চা', quantity: 2, unit_price_bdt: 60, variant: 'Large' }]);
  assert.deepEqual(order.shipment, {
    id: 'shipment-1', provider: 'PATHAO', tracking_id: 'PA-123', status: 'BOOKED', mode: 'sandbox'
  });
  assert.ok(h.calls.some(call => call.sql.includes('LEFT JOIN LATERAL') && call.sql.includes('FROM shipments')));
});
