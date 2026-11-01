import test from 'node:test';
import assert from 'node:assert/strict';
import registerPostgresDomain from '../apps/api/src/routes_postgres_domain.mjs';
import { HttpError } from '../apps/api/src/core.mjs';

function buildRoutes(overrides = {}) {
  const calls = [];
  const repositories = {
    inventory: {
      getStock: async () => ({ product_id: 'p-1', stock: 5, seller_id: 'seller-1' }),
      setStock: async input => ({ stock: input.stock }),
      adjustStock: async input => ({ ...input, stock: 8 }),
      listMovements: async () => []
    },
    checkout: {
      getCart: async () => ({ items: [], subtotal_paisa: 0, item_count: 0 }),
      setItemQuantity: async () => ({ items: [], subtotal_paisa: 0, item_count: 0 }),
      removeItem: async () => ({ items: [], subtotal_paisa: 0, item_count: 0 }),
      clearCart: async () => ({ items: [], subtotal_paisa: 0, item_count: 0 }),
      validateCoupon: async () => ({ code: 'SAVE10', discount_paisa: 1000 }),
      checkout: async () => ({
        id: 'order-1', payment_id: 'payment-1', total_paisa: 11000,
        subtotal_paisa: 10000, shipping_paisa: 1000, discount_paisa: 0,
        status: 'AWAITING_PAYMENT', payment_status: 'PENDING', payment_method: 'BKASH'
      })
    },
    customer: {
      listAddresses: async () => [], createAddress: async () => ({ id: 'address-1' }),
      updateAddress: async input => ({ id: input.addressId }), deleteAddress: async () => ({ deleted: true }),
      listWishlist: async () => [], addWishlist: async () => ({ added: true }),
      removeWishlist: async () => ({ removed: true }), saveReview: async () => ({ saved: true })
    },
    orders: {
      listCustomerOrders: async () => [],
      getCustomerOrder: async () => null,
      getTracking: async () => null,
      getCustomerPayment: async () => null,
      prepareCustomerPayment: async () => ({ id: 'payment-1', amount_paisa: 11000 }),
      setPaymentInitiated: async input => ({ id: input.paymentId, status: 'INITIATED', gateway_txn_id: input.gatewayTxnId }),
      recordVerifiedPaymentCallback: async input => { calls.push(['callback', input]); return { status: 'PAID' }; },
      transitionParentOrder: async input => ({ id: input.orderId, status: input.nextStatus }),
      transitionSellerOrder: async input => ({ id: input.sellerOrderId, status: input.nextStatus }),
      listSellerOrders: async () => [],
      getSellerOrder: async () => null,
      listAdminOrders: async () => [],
      getAdminOrder: async () => null
    },
    ...overrides
  };
  const routes = [];
  registerPostgresDomain(
    (method, pattern, roles, handler) => routes.push({ method, pattern, roles, handler }),
    (data, status = 200) => ({ status, body: { data } }),
    {
      repositories,
      gatewayInitiate: (method, payment) => ({ gatewayTxnId: 'gw-123', redirectUrl: '/sandbox', sandbox: true }),
      gatewayVerify: () => true,
      gatewaySign: () => 'signed',
      paymentMode: 'sandbox'
    }
  );
  return { routes, repositories, calls };
}
function route(app, method, pattern) {
  const found = app.routes.find(item => item.method === method && item.pattern === pattern);
  assert.ok(found, method + ' ' + pattern + ' route is registered');
  return found.handler;
}


test('PostgreSQL customer account routes delegate address, wishlist and review operations', async () => {
  const app = buildRoutes();
  const address = await route(app, 'POST', '/api/v1/customer/addresses')({
    user: { id: 'buyer-1', name: 'Buyer' }, body: { name: 'Buyer' }
  });
  assert.equal(address.status, 201);
  assert.equal(address.body.data.id, 'address-1');

  const wishlist = await route(app, 'POST', '/api/v1/customer/wishlist')({
    user: { id: 'buyer-1' }, body: { productId: 'p-1' }
  });
  assert.equal(wishlist.status, 201);
  assert.deepEqual(wishlist.body.data, { added: true });

  const review = await route(app, 'POST', '/api/v1/customer/products/:id/reviews')({
    user: { id: 'buyer-1' }, params: ['p-1'], body: { rating: 5 }
  });
  assert.equal(review.status, 201);
  assert.deepEqual(review.body.data, { saved: true });
});

test('PostgreSQL domain routes provide the existing customer cart response shape', async () => {
  const app = buildRoutes();
  app.repositories.checkout.getCart = async () => ({
    items: [{ product_id: 'p-1', unit_price_paisa: 12500, line_total_paisa: 25000, quantity: 2 }],
    subtotal_paisa: 25000, item_count: 2
  });
  const response = await route(app, 'GET', '/api/v1/customer/cart')({ user: { id: 'buyer-1' } });
  assert.equal(response.body.data.subtotal_bdt, 250);
  assert.equal(response.body.data.items[0].unit_price_bdt, 125);
  assert.equal(response.body.data.items[0].line_total_bdt, 250);
});

test('seller stock route rejects a product not owned by the authenticated seller', async () => {
  const app = buildRoutes();
  app.repositories.inventory.getStock = async () => ({ product_id: 'p-1', stock: 5, seller_id: 'seller-other' });
  await assert.rejects(
    route(app, 'PATCH', '/api/v1/seller/products/:id/stock')({
      user: { id: 'seller-1' }, params: ['p-1'], body: { stock: 12 }
    }),
    error => error instanceof HttpError && error.status === 404
  );
});

test('online checkout starts the gateway after repository checkout and stores its transaction id', async () => {
  const app = buildRoutes();
  const response = await route(app, 'POST', '/api/v1/checkout')({
    user: { id: 'buyer-1' },
    body: {
      delivery: { name: 'Buyer', phone: '01711111111', address: 'Road 1', area: 'Dhaka' },
      payment_method: 'BKASH'
    }
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.orderNumber, 'BD-ORDER-1');
  assert.equal(response.body.data.payment.id, 'payment-1');
  assert.equal(response.body.data.payment.status, 'INITIATED');
});

test('payment webhook rejects an invalid signature before repository mutation', async () => {
  const app = buildRoutes();
  // Re-register with a rejecting verifier for the specific test.
  const routes = [];
  registerPostgresDomain(
    (method, pattern, roles, handler) => routes.push({ method, pattern, roles, handler }),
    (data, status = 200) => ({ status, body: { data } }),
    { repositories: app.repositories, gatewayVerify: () => false }
  );
  const callback = routes.find(item => item.method === 'POST' && item.pattern === '/api/v1/payments/callback/:gateway').handler;
  await assert.rejects(
    callback({ params: ['BKASH'], body: { gateway_txn_id: 'gw', amount_bdt: 100, status: 'SUCCESS', signature: 'wrong' } }),
    error => error instanceof HttpError && error.status === 401
  );
  assert.equal(app.calls.length, 0);
});

test('customer cannot retrieve another user payment via payment status route', async () => {
  const app = buildRoutes();
  app.repositories.orders.getCustomerPayment = async () => null;
  await assert.rejects(
    route(app, 'GET', '/api/v1/payments/:id/status')({ user: { id: 'buyer-1' }, params: ['private-payment'] }),
    error => error instanceof HttpError && error.status === 404
  );
});

test('customer cancellation uses the owner-scoped repository method, not admin transition', async () => {
  const app = buildRoutes();
  let scoped = null;
  app.repositories.orders.cancelCustomerOrder = async input => { scoped = input; return { id: input.orderId, status: 'CANCELLED' }; };
  const result = await route(app, 'POST', '/api/v1/customer/orders/:id/cancel')({
    user: { id: 'buyer-1' }, params: ['order-1'], body: { reason: 'Changed my mind' }
  });
  assert.equal(result.body.data.status, 'CANCELLED');
  assert.equal(scoped.userId, 'buyer-1');
  assert.equal(scoped.orderId, 'order-1');
});
