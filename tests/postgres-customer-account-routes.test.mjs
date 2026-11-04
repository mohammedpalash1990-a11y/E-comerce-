import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresCustomerAccountRoutes } from '../apps/api/src/postgres-customer-account-routes.mjs';

const user = { id: 'customer-1', name: 'Buyer', role: 'CUSTOMER' };

function setup({ repository } = {}) {
  const routes = [], calls = [];
  const customer = repository || new Proxy({}, {
    get: (_target, name) => (...args) => { calls.push([name, ...args]); return { method: name, args }; }
  });
  registerPostgresCustomerAccountRoutes(
    (method, path, roles, handler) => routes.push({ method, path, roles, handler }),
    (data, status = 200) => ({ data, status }),
    { customerRepository: customer }
  );
  const call = (method, path, { body, params = [], session = user } = {}) => {
    const match = routes.find(route => route.method === method && route.path === path);
    assert.ok(match, `missing route ${method} ${path}`);
    return match.handler({ user: session, body, params, url: new URL('https://example.test/') });
  };
  return { routes, calls, call };
}

test('registers the legacy customer account paths as CUSTOMER-only routes without a cart overflow', () => {
  const { routes } = setup();
  assert.deepEqual(routes.map(({ method, path, roles }) => `${method} ${path} ${roles.join(',')}`), [
    'GET /api/v1/customer/addresses CUSTOMER',
    'POST /api/v1/customer/addresses CUSTOMER',
    'PUT /api/v1/customer/addresses/:id CUSTOMER',
    'DELETE /api/v1/customer/addresses/:id CUSTOMER',
    'GET /api/v1/customer/wishlist CUSTOMER',
    'POST /api/v1/customer/wishlist CUSTOMER',
    'DELETE /api/v1/customer/wishlist/:pid CUSTOMER',
    'POST /api/v1/customer/products/:id/reviews CUSTOMER'
  ]);
  for (const route of routes) assert.deepEqual(route.roles, ['CUSTOMER']);
});

test('requires a usable customer repository instead of failing lazily at request time', () => {
  assert.throws(() => registerPostgresCustomerAccountRoutes(() => {}, () => {}, { customerRepository: {} }), /customer repository/);
  assert.throws(() => registerPostgresCustomerAccountRoutes(() => {}, () => {}, {}), /customer repository/);
});

test('address routes scope writes to the authenticated customer and return 201 on creation', async () => {
  const h = setup();
  const body = { label: 'Home', phone: '01711111111', address: 'Road 1', area: 'Dhaka' };
  assert.deepEqual(await h.call('POST', '/api/v1/customer/addresses', { body }), { status: 201, data: { method: 'createAddress', args: [{ user, body }] } });
  assert.deepEqual(h.calls[0], ['createAddress', { user, body }]);
  await h.call('PUT', '/api/v1/customer/addresses/:id', { body, params: ['a-1'] });
  assert.deepEqual(h.calls[1], ['updateAddress', { user, addressId: 'a-1', body }]);
  await h.call('DELETE', '/api/v1/customer/addresses/:id', { params: ['a-1'] });
  assert.deepEqual(h.calls[2], ['deleteAddress', user.id, 'a-1']);
  await h.call('GET', '/api/v1/customer/addresses');
  assert.deepEqual(h.calls[3], ['listAddresses', user.id]);
});

test('wishlist and review routes use the session owner, never a body-supplied user', async () => {
  const h = setup();
  assert.deepEqual(await h.call('POST', '/api/v1/customer/wishlist', { body: { productId: 'p-1' } }), {
    status: 201, data: { method: 'addWishlist', args: [user.id, 'p-1'] }
  });
  await h.call('POST', '/api/v1/customer/wishlist', { body: { productId: 'p-2', userId: 'someone-else' } });
  assert.deepEqual(h.calls[1], ['addWishlist', user.id, 'p-2']);
  await h.call('DELETE', '/api/v1/customer/wishlist/:pid', { params: ['p-1'] });
  assert.deepEqual(h.calls[2], ['removeWishlist', user.id, 'p-1']);
  await h.call('GET', '/api/v1/customer/wishlist');
  assert.deepEqual(h.calls[3], ['listWishlist', user.id]);
  assert.deepEqual(await h.call('POST', '/api/v1/customer/products/:id/reviews', { body: { rating: 5, comment: 'ভালো' }, params: ['p-1'] }), {
    status: 201, data: { method: 'saveReview', args: [{ userId: user.id, productId: 'p-1', body: { rating: 5, comment: 'ভালো' } }] }
  });
});

test('repository failures propagate unchanged so HTTP statuses stay meaningful', async () => {
  const failing = error => new Proxy({ listAddresses: () => {} }, {
    get: (target, name) => name === 'listAddresses' ? target.listAddresses : () => { throw error; }
  });
  const { call } = setup({ repository: failing(Object.assign(new Error('Address not found'), { status: 404 })) });
  await assert.rejects(call('PUT', '/api/v1/customer/addresses/:id', { body: {}, params: ['x'] }), error => error.status === 404);
  const { call: forbidden } = setup({ repository: failing(Object.assign(new Error('review not allowed'), { status: 403 })) });
  await assert.rejects(forbidden('POST', '/api/v1/customer/products/:id/reviews', { body: { rating: 5 }, params: ['p-1'] }), error => error.status === 403);
});

test('a missing JSON body is passed through for the repository to reject, not silently defaulted', async () => {
  const h = setup();
  await h.call('POST', '/api/v1/customer/wishlist', { body: undefined });
  assert.deepEqual(h.calls[0], ['addWishlist', user.id, undefined]);
});
