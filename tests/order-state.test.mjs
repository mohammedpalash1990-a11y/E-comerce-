import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITIONS, conflict, canTransition } from '../apps/api/src/order-state.mjs';
import { HttpError } from '../apps/api/src/postgres-shared.mjs';

test('order lifecycle policy loads without importing SQLite core', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../apps/api/src/order-state.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\/core\.mjs['"]/);
});

test('order lifecycle transitions preserve the existing allowed state graph', () => {
  assert.deepEqual(TRANSITIONS, {
    AWAITING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
    CONFIRMED: ['PROCESSING', 'CANCELLED'],
    PROCESSING: ['SHIPPED', 'CANCELLED'],
    SHIPPED: ['DELIVERED']
  });
  assert.equal(canTransition('CONFIRMED', 'PROCESSING'), true);
  assert.equal(canTransition('CONFIRMED', 'DELIVERED'), false);
  assert.equal(canTransition('DELIVERED', 'CANCELLED'), false);
  assert.throws(() => { throw conflict(); }, error => error instanceof HttpError && error.status === 409);
});
