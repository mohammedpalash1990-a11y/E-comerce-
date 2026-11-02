import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresInventoryRepository } from '../apps/api/src/postgres-inventory.mjs';
import { registerPostgresInventoryRoutes } from '../apps/api/src/postgres-inventory-routes.mjs';

function inventoryDb({ product = { id: 'product-1', seller_id: 'seller-1', stock: 8 }, existing = null } = {}) {
  const calls = [];
  const movements = [];
  const audits = [];
  let current = { ...product };
  const database = {
    q(sql) {
      return {
        async get(...args) {
          calls.push({ sql, args, method: 'get' });
          if (sql.includes('FROM inventory_movements WHERE seller_id=? AND idempotency_key=?')) {
            return movements.find(row => row.seller_id === args[0] && row.idempotency_key === args[1]) || existing || undefined;
          }
          if (sql.includes('FROM products p JOIN seller_profiles')) {
            return current && current.id === args[0] && current.seller_id === args[1]
              ? { ...current } : undefined;
          }
          return undefined;
        },
        async all(...args) {
          calls.push({ sql, args, method: 'all' });
          if (sql.includes('UPDATE products SET stock')) {
            const [stock, , id, sellerId, before] = args;
            if (!current || current.id !== id || current.seller_id !== sellerId || current.stock !== before) return [];
            current.stock = stock;
            return [{ stock }];
          }
          if (sql.includes('FROM inventory_movements WHERE seller_id=? AND product_id=?')) {
            return movements.filter(row => row.seller_id === args[0] && row.product_id === args[1]);
          }
          if (sql.includes('FROM products p JOIN seller_profiles')) return current ? [{ ...current }] : [];
          return [];
        },
        async run(...args) {
          calls.push({ sql, args, method: 'run' });
          if (sql.includes('INSERT INTO inventory_movements')) {
            const [id, product_id, seller_id, actor_id, quantity_delta, stock_before, stock_after, reason, idempotency_key, created_at] = args;
            const row = { id, product_id, seller_id, actor_id, quantity_delta, stock_before, stock_after, reason, idempotency_key, created_at };
            movements.push(row);
          }
          if (sql.includes('INSERT INTO audit_logs')) audits.push(args);
          return { changes: 1, rows: [] };
        }
      };
    },
    async tx(fn) { return fn(); }
  };
  return { database, calls, movements, audits, get product() { return current; } };
}

const valid = { delta: 3, reason: 'নতুন পণ্য স্টকে যোগ', idempotencyKey: 'request-0001' };

test('seller stock adjustment locks owned approved product and writes movement plus audit', async () => {
  const h = inventoryDb();
  const repo = createPostgresInventoryRepository(h.database, { id: () => 'movement-1', now: () => '2026-11-03T00:00:00.000Z' });
  const result = await repo.adjustSellerStock({ id: 'seller-1' }, 'product-1', valid);
  assert.equal(result.stock_before, 8);
  assert.equal(result.stock_after, 11);
  assert.equal(result.quantity_delta, 3);
  assert.equal(result.duplicate, false);
  assert.equal(h.product.stock, 11);
  assert.equal(h.movements.length, 1);
  assert.equal(h.audits.length, 1);
  assert.ok(h.calls.some(call => call.sql.includes('FOR UPDATE OF p')));
});

test('repeated idempotency key returns existing movement without changing stock twice', async () => {
  const h = inventoryDb();
  const repo = createPostgresInventoryRepository(h.database, { id: () => 'movement-2' });
  await repo.adjustSellerStock({ id: 'seller-1' }, 'product-1', valid);
  const second = await repo.adjustSellerStock({ id: 'seller-1' }, 'product-1', valid);
  assert.equal(second.duplicate, true);
  assert.equal(h.product.stock, 11);
  assert.equal(h.movements.length, 1);
});

test('seller cannot adjust another seller product', async () => {
  const h = inventoryDb({ product: { id: 'product-1', seller_id: 'seller-2', stock: 8 } });
  const repo = createPostgresInventoryRepository(h.database);
  await assert.rejects(repo.adjustSellerStock({ id: 'seller-1' }, 'product-1', valid), error => error.status === 404);
  assert.equal(h.movements.length, 0);
  assert.equal(h.product.stock, 8);
});

test('rejects zero, oversized, unsafe and malformed idempotency adjustments', async () => {
  const h = inventoryDb();
  const repo = createPostgresInventoryRepository(h.database);
  for (const input of [
    { ...valid, delta: 0 },
    { ...valid, delta: 21 },
    { ...valid, delta: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, idempotencyKey: 'bad' }
  ]) {
    await assert.rejects(repo.adjustSellerStock({ id: 'seller-1' }, 'product-1', input), error => error.status === 400);
  }
  assert.equal(h.product.stock, 8);
  assert.equal(h.movements.length, 0);
});

test('rejects stock underflow and does not write movement or audit', async () => {
  const h = inventoryDb({ product: { id: 'product-1', seller_id: 'seller-1', stock: 2 } });
  const repo = createPostgresInventoryRepository(h.database);
  await assert.rejects(repo.adjustSellerStock({ id: 'seller-1' }, 'product-1', {
    ...valid, delta: -3
  }), error => error.status === 409);
  assert.equal(h.product.stock, 2);
  assert.equal(h.movements.length, 0);
  assert.equal(h.audits.length, 0);
});

test('registers seller-only inventory routes and delegates adjustment', async () => {
  const routes = [];
  const repo = {
    listSellerInventory: async id => [{ id }],
    listMovements: async (id, productId) => [{ id, productId }],
    adjustSellerStock: async (user, productId, input) => ({ productId, sellerId: user.id, input, duplicate: false })
  };
  registerPostgresInventoryRoutes((method, path, roles, handler) => routes.push({ method, path, roles, handler }),
    (data, status = 200) => ({ data, status }), { database: { q() {}, tx() {} }, inventoryRepository: repo });
  assert.equal(routes.length, 3);
  assert.ok(routes.every(route => route.roles.join(',') === 'SELLER'));
  const response = await routes.find(route => route.path.endsWith('/adjust')).handler({
    user: { id: 'seller-1' }, params: ['product-1'],
    body: { delta: 2, reason: 'Stock count', idempotency_key: 'request-0002' }
  });
  assert.equal(response.status, 201);
  assert.equal(response.data.sellerId, 'seller-1');
  assert.equal(response.data.input.idempotencyKey, 'request-0002');
});
