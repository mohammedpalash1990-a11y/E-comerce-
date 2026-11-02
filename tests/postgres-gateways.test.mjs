import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PAYMENT_METHODS,
  COURIERS,
  shippingFor,
  initiateGateway,
  signCallback,
  verifySignature,
  courierQuote,
  courierBook,
  SHIPMENT_STATUSES
} from '../apps/api/src/gateways.mjs';

test('gateway adapters load without importing the SQLite core', async () => {
  const source = await readFile(new URL('../apps/api/src/gateways.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\/core\.mjs['"]/);
  assert.match(source, /from ['"]\.\/postgres-shared\.mjs['"]/);
});

test('sandbox payment and courier adapters retain supported contracts', () => {
  assert.deepEqual(PAYMENT_METHODS, ['COD', 'BKASH', 'NAGAD', 'ROCKET', 'SSLCOMMERZ']);
  assert.deepEqual(COURIERS, ['PATHAO', 'STEADFAST', 'REDX']);
  assert.equal(shippingFor('Dhaka', 0), 6000);
  assert.equal(shippingFor('Chattogram', 0), 12000);
  const payment = initiateGateway('BKASH', { id: 'payment-1' });
  assert.equal(payment.sandbox, true);
  assert.match(payment.gatewayTxnId, /^SBX-BKASH-/);
  assert.equal(payment.redirectUrl, '/api/v1/payments/sandbox/payment-1');
  const quote = courierQuote('PATHAO', 'Dhaka');
  assert.equal(quote, 6000);
  const shipment = courierBook('PATHAO', 'Dhaka');
  assert.equal(shipment.status, 'BOOKED');
  assert.equal(shipment.charge, 6000);
  assert.match(shipment.trackingId, /^PA-/);
  assert.ok(SHIPMENT_STATUSES.includes('DELIVERED'));
});

test('gateway callback signature is deterministic and rejects tampering', () => {
  const payload = { gatewayTxnId: 'SBX-BKASH-123', amountPaisa: 12500, status: 'PAID' };
  const signature = signCallback(payload);
  assert.equal(verifySignature(payload, signature), true);
  assert.equal(verifySignature({ ...payload, amountPaisa: 12501 }, signature), false);
  assert.equal(verifySignature(payload, 'invalid'), false);
});
