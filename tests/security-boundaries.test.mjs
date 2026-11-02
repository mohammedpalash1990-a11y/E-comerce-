import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, delivery } from './helpers.mjs';

const api = await startApi(4422, { CORS_ORIGINS: 'https://shop.example' });
const { request: R, login } = api;
test.after(() => api.stop());

const state = {};

test('security headers and CORS allow only the configured storefront origin', async () => {
  const allowed = await R('/health', { headers: { origin: 'https://shop.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(allowed.headers.get('x-frame-options'), 'DENY');
  assert.equal(allowed.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://shop.example');

  const preflight = await R('/api/v1/checkout', {
    method: 'OPTIONS',
    headers: { origin: 'https://shop.example', 'access-control-request-method': 'POST' }
  });
  assert.equal(preflight.status, 204);
  const denied = await R('/api/v1/checkout', {
    method: 'OPTIONS',
    headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' }
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('protected routes enforce authentication and role boundaries', async () => {
  assert.equal((await R('/api/v1/customer/orders')).status, 401);
  assert.equal((await R('/api/v1/seller/orders')).status, 401);
  assert.equal((await R('/api/v1/admin/orders')).status, 401);

  state.admin = (await login('01700000001', 'Admin@12345')).data.token;
  state.seller = (await login('01700000002', 'Seller@12345')).data.token;
  state.customer = (await login('01700000003', 'Customer@12345')).data.token;

  assert.equal((await R('/api/v1/admin/orders', { token: state.customer })).status, 403);
  assert.equal((await R('/api/v1/seller/orders', { token: state.customer })).status, 403);
  assert.equal((await R('/api/v1/customer/orders', { token: state.seller })).status, 403);
  assert.equal((await R('/api/v1/admin/dashboard', { token: state.seller })).status, 403);
});

test('seller and customer records cannot be read or mutated by another account', async () => {
  const customer2 = await R('/api/v1/auth/register', {
    method: 'POST',
    body: {
      name: 'Second Buyer', phone: '01822222222', email: 'second-buyer@example.com',
      password: 'BuyerPass123!', confirm_password: 'BuyerPass123!'
    }
  });
  assert.equal(customer2.status, 201);
  state.customer2 = customer2.data.token;

  const seller2 = await R('/api/v1/auth/register-seller', {
    method: 'POST',
    body: {
      name: 'Second Seller', phone: '01922222222', email: 'second-seller@example.com',
      password: 'SellerPass123!', confirm_password: 'SellerPass123!',
      shop_name: 'Second Shop', shop_address: 'Chattogram',
      business_info: 'General retail', kyc_nid: '1987654321098'
    }
  });
  assert.equal(seller2.status, 201);
  state.seller2 = seller2.data.token;

  const catalog = await R('/api/v1/products?limit=10');
  assert.equal(catalog.status, 200);
  const product = catalog.data.data.find(p => p.name_en === 'Wireless Earbuds');
  assert.ok(product, 'seeded seller product should be available');

  const checkout = await R('/api/v1/checkout', {
    method: 'POST', token: state.customer,
    body: { delivery: delivery(), items: [{ productId: product.id, quantity: 1 }] }
  });
  assert.equal(checkout.status, 201);

  const ownSellerOrders = await R('/api/v1/seller/orders', { token: state.seller });
  assert.equal(ownSellerOrders.status, 200);
  const ownSubOrder = ownSellerOrders.data.data.find(o => o.orderNumber === checkout.data.data.orderNumber);
  assert.ok(ownSubOrder, 'own seller sub-order should be visible');

  const otherSellerProducts = await R('/api/v1/seller/products', { token: state.seller2 });
  assert.equal(otherSellerProducts.status, 200);
  assert.equal(otherSellerProducts.data.data.length, 0);
  assert.equal((await R('/api/v1/seller/products/' + product.id, { token: state.seller2 })).status, 404);
  assert.equal((await R('/api/v1/seller/orders/' + ownSubOrder.id, { token: state.seller2 })).status, 404);
  assert.equal((await R('/api/v1/seller/orders/' + ownSubOrder.id + '/status', {
    method: 'POST', token: state.seller2, body: { status: 'PROCESSING' }
  })).status, 404);

  assert.equal((await R('/api/v1/customer/orders/' + checkout.data.data.id, { token: state.customer2 })).status, 404);
  assert.equal((await R('/api/v1/customer/orders/' + checkout.data.data.id + '/tracking', { token: state.customer2 })).status, 404);
  assert.equal((await R('/api/v1/customer/orders/' + checkout.data.data.id + '/cancel', {
    method: 'POST', token: state.customer2, body: { reason: 'not my order' }
  })).status, 404);

  const adminOrders = await R('/api/v1/admin/orders', { token: state.admin });
  assert.ok(adminOrders.data.data.some(o => o.id === checkout.data.data.id));
});
