import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresInventoryRepository } from '../apps/api/src/postgres-inventory.mjs';
import { createScriptedDatabase } from './postgres-domain-test-helpers.mjs';

test('inventory adjustment locks product and records an immutable movement', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.startsWith('SELECT id,stock')) return { id: 'p-1', stock: 8, active: 1, status: 'ACTIVE', seller_id: 's-1' };
    if (method === 'get' && sql.startsWith('UPDATE products')) return { id: 'p-1', stock: 11 };
    return { changes: 1 };
  });
  const repo = createPostgresInventoryRepository(database, { createId: () => 'fixed-id', clock: () => '2026-11-01T00:00:00.000Z' });
  const result = await repo.adjustStock({ productId: 'p-1', delta: 3, reason: 'Supplier delivery', actorId: 'admin-1', reference: 'GRN-17' });
  assert.equal(result.previous_stock, 8);
  assert.equal(result.stock, 11);
  assert.equal(result.delta, 3);
  assert.equal(database.transactionCount, 1);
  assert.match(database.calls[0].sql, /FOR UPDATE$/);
  const movement = database.calls.find(c => c.sql.startsWith('INSERT INTO inventory_movements'));
  assert.deepEqual(movement.params, ['fixed-id', 'p-1', 3, 8, 11, 'Supplier delivery', 'admin-1', 'GRN-17', '2026-11-01T00:00:00.000Z']);
});

test('inventory adjustment rejects negative stock and performs no write', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.startsWith('SELECT id,stock')) return { id: 'p-1', stock: 2 };
    return { changes: 1 };
  });
  const repo = createPostgresInventoryRepository(database);
  await assert.rejects(repo.adjustStock({ productId: 'p-1', delta: -3, reason: 'Correction' }), error => error.code === 'INVALID_STOCK' && error.status === 409);
  assert.equal(database.calls.some(c => c.sql.startsWith('UPDATE products')), false);
});

test('inventory validation rejects zero adjustments and unsafe limits', async () => {
  const repo = createPostgresInventoryRepository(createScriptedDatabase(() => null));
  await assert.rejects(repo.adjustStock({ productId: 'p-1', delta: 0, reason: 'No-op' }), /must not be zero/);
  await assert.rejects(repo.listMovements({ limit: 1.5 }), /safe integer/);
});

test('setStock computes the delta under the row lock and leaves unchanged stock unlogged', async () => {
  const database = createScriptedDatabase(({ method, sql }) => {
    if (method === 'get' && sql.startsWith('SELECT id,stock')) return { id: 'p-1', stock: 10 };
    return { changes: 1 };
  });
  const repo = createPostgresInventoryRepository(database);
  const result = await repo.setStock({ productId: 'p-1', stock: 10, reason: 'Count check' });
  assert.equal(result.unchanged, true);
  assert.equal(database.calls.some(c => c.sql.startsWith('INSERT INTO inventory_movements')), false);
});
