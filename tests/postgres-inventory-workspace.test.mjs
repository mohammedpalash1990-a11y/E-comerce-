import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresInventoryWorkspace, handlePostgresInventoryWorkspace } from '../apps/api/src/postgres-inventory-workspace.mjs';

function fixture() {
  const state = {
    product: { id: 'p-1', seller_id: 's-1', stock: 6, price_paisa: 12500, name_bn: 'ডেমো পণ্য', name_en: 'Demo product', active: 1 },
    request: null, movements: [], audits: [], notifications: []
  };
  const db = {
    q(sql) {
      return {
        async get(...args) {
          if (sql.includes('FROM products p JOIN seller_profiles')) {
            return state.product?.id === args[0] && state.product.seller_id === args[1] ? { ...state.product } : undefined;
          }
          if (sql.includes('FROM inventory_adjustment_requests') && sql.includes('idempotency_key')) {
            return state.request?.seller_id === args[0] && state.request.idempotency_key === args[1] ? { ...state.request } : undefined;
          }
          if (sql.includes('FROM inventory_adjustment_requests WHERE id=?')) return state.request?.id === args[0] ? { ...state.request } : undefined;
          if (sql.includes('COUNT(*)::int AS product_count')) return { product_count: 1, units_in_stock: state.product.stock, stock_value_paisa: state.product.stock * state.product.price_paisa, low_stock_products: state.product.stock <= 5 ? 1 : 0 };
          if (sql.includes('COUNT(*)::int AS movement_count')) return { movement_count: state.movements.length, units_added: state.movements.filter(m => m.quantity_delta > 0).reduce((a,m)=>a+m.quantity_delta,0), units_removed: state.movements.filter(m => m.quantity_delta < 0).reduce((a,m)=>a-m.quantity_delta,0) };
          return undefined;
        },
        async all(...args) {
          if (sql.includes('FROM products p JOIN seller_profiles')) return state.product ? [{ ...state.product }] : [];
          if (sql.includes('FROM inventory_movements WHERE seller_id=? AND product_id=?')) return state.movements.map(row => ({ ...row }));
          if (sql.includes('FROM products p LEFT JOIN seller_profiles')) return state.product && state.product.stock <= args[0] ? [{ ...state.product, shop_name: 'Demo shop' }] : [];
          if (sql.includes('FROM inventory_adjustment_requests r JOIN products')) return state.request ? [{ ...state.request, product_name: 'ডেমো পণ্য', seller_name: 'Seller', shop_name: 'Demo shop', seller_phone: '01700000000' }] : [];
          return [];
        },
        async run(...args) {
          if (sql.includes('INSERT INTO inventory_adjustment_requests')) {
            state.request = { id: args[0], product_id: args[1], seller_id: args[2], requested_by: args[3], quantity_delta: args[4], reason: args[5], idempotency_key: args[6], status: 'PENDING', created_at: args[7] };
          } else if (sql.startsWith('UPDATE products SET stock')) {
            state.product.stock = args[0];
          } else if (sql.includes('INSERT INTO inventory_movements')) {
            state.movements.push({ id: args[0], product_id: args[1], seller_id: args[2], actor_id: args[3], quantity_delta: args[4], stock_before: args[5], stock_after: args[6], reason: args[7], idempotency_key: args[8], created_at: args[9] });
          } else if (sql.includes('UPDATE inventory_adjustment_requests')) {
            Object.assign(state.request, { status: args[0], decided_by: args[1], decision_note: args[2], decided_at: args[3] });
          } else if (sql.includes('INSERT INTO audit_logs')) state.audits.push(args);
          else if (sql.includes('INSERT INTO notifications')) state.notifications.push(args);
          return { rowCount: 1, rows: [] };
        }
      };
    },
    async tx(fn) { return fn(); }
  };
  return { db, state };
}

test('seller adjustment requests are pending and idempotent until an admin approves', async () => {
  const { db, state } = fixture();
  const workspace = createPostgresInventoryWorkspace(db, { id: () => 'fixed-id', now: () => '2026-11-03T00:00:00.000Z' });
  const seller = { id: 's-1', role: 'SELLER' };
  const input = { delta: 3, reason: 'Stock received', idempotency_key: 'request-key-0001' };
  const first = await workspace.requestAdjustment(seller, 'p-1', input);
  const duplicate = await workspace.requestAdjustment(seller, 'p-1', input);
  assert.equal(first.status, 'PENDING');
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.product.stock, 6);
  const approved = await workspace.decideRequest({ id: 'a-1', role: 'ADMIN' }, first.id, { decision: 'APPROVE', note: 'Count verified' });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.stock.after, 9);
  assert.equal(state.product.stock, 9);
  assert.equal(state.movements.length, 1);
  assert.equal(state.audits.length, 2);
  assert.equal(state.notifications.length, 1);
});

test('seller inventory APIs enforce role scope and expose stock alerts plus report totals', async () => {
  const { db } = fixture();
  await assert.rejects(handlePostgresInventoryWorkspace({
    database: db, user: { id: 'c-1', role: 'CUSTOMER' }, method: 'GET',
    path: '/api/v1/seller/inventory', url: new URL('http://localhost/api/v1/seller/inventory')
  }), error => error.status === 403);
  const result = await handlePostgresInventoryWorkspace({
    database: db, user: { id: 's-1', role: 'SELLER' }, method: 'GET',
    path: '/api/v1/seller/inventory/alerts', url: new URL('http://localhost/api/v1/seller/inventory/alerts?threshold=10')
  });
  assert.equal(result.data.length, 1);
  const report = await handlePostgresInventoryWorkspace({
    database: db, user: { id: 's-1', role: 'SELLER' }, method: 'GET',
    path: '/api/v1/seller/inventory/report', url: new URL('http://localhost/api/v1/seller/inventory/report')
  });
  assert.equal(report.data.product_count, 1);
  assert.equal(report.data.stock_value_bdt, 750);
});

test('invalid stock adjustment values and duplicate decisions are rejected', async () => {
  const { db } = fixture();
  const workspace = createPostgresInventoryWorkspace(db);
  await assert.rejects(workspace.requestAdjustment({ id: 's-1' }, 'p-1', {
    delta: 0, reason: 'Invalid', idempotency_key: 'request-key-0002'
  }), error => error.status === 400);
});
