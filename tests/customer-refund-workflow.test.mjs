import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, delivery } from './helpers.mjs';

const api = await startApi(4439);
const { request: R, login } = api;
test.after(() => api.stop());

test('customer refund request flows end-to-end from delivered order to admin approval and seller reversal', async () => {
  const admin = (await login('01700000001', 'Admin@12345')).data.token;
  const seller = (await login('01700000002', 'Seller@12345')).data.token;
  const customer = (await login('01700000003', 'Customer@12345')).data.token;

  const prod = (await R('/api/v1/products?limit=10')).data.data[0];
  assert.ok(prod);

  const created = await R('/api/v1/checkout', {
    method: 'POST',
    token: customer,
    body: { delivery: delivery(), payment_method: 'COD', items: [{ productId: prod.id, quantity: 1 }] }
  });
  assert.equal(created.status, 201);
  const orderId = created.data.data.id;

  // Cannot request refund before delivery
  const early = await R('/api/v1/customer/orders/' + orderId + '/refund-request', {
    method: 'POST',
    token: customer,
    body: { reason: 'Changed mind early' }
  });
  assert.equal(early.status, 409);

  // Move order through PROCESSING -> SHIPPED -> DELIVERED (COD becomes PAID)
  for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED']) {
    const step = await R('/api/v1/admin/orders/' + orderId + '/status', {
      method: 'POST',
      token: admin,
      body: { status }
    });
    assert.equal(step.status, 200);
  }

  // Non-customer role cannot use customer refund endpoint
  assert.equal((await R('/api/v1/customer/orders/' + orderId + '/refund-request', {
    method: 'POST',
    token: seller,
    body: { reason: 'Unauthorized' }
  })).status, 403);

  // Customer requests partial refund
  const partialAmt = Math.min(200, Math.floor(created.data.data.total_bdt / 2));
  const req1 = await R('/api/v1/customer/orders/' + orderId + '/refund-request', {
    method: 'POST',
    token: customer,
    body: { amount_bdt: partialAmt, reason: 'Packaging dented on arrival' }
  });
  assert.equal(req1.status, 201);
  assert.equal(req1.data.data.status, 'REQUESTED');
  assert.equal(req1.data.data.amount_bdt, partialAmt);

  // Over-refund beyond remaining balance is rejected
  const over = await R('/api/v1/customer/orders/' + orderId + '/refund-request', {
    method: 'POST',
    token: customer,
    body: { amount_bdt: created.data.data.total_bdt, reason: 'Too much' }
  });
  assert.equal(over.status, 409);

  // Admin sees pending refund and approves it
  const refunds = (await R('/api/v1/admin/refunds', { token: admin })).data.data;
  const mine = refunds.find(r => r.id === req1.data.data.id);
  assert.ok(mine);
  assert.equal(mine.status, 'REQUESTED');

  const approved = await R('/api/v1/admin/refunds/' + mine.id + '/approve', {
    method: 'POST',
    token: admin
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.data.status, 'APPROVED');

  // Order payment status updates to PARTIALLY_REFUNDED and seller ledger records SELLER_REVERSAL
  const ordDetail = (await R('/api/v1/customer/orders/' + orderId, { token: customer })).data.data;
  assert.equal(ordDetail.payment.status, 'PARTIALLY_REFUNDED');
  const fin = (await R('/api/v1/seller/finance', { token: seller })).data.data;
  assert.ok(fin.settlements.some(s => s.kind === 'SELLER_REVERSAL'));
});
