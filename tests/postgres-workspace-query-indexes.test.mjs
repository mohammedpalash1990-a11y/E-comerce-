import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationPath = new URL('../apps/api/migrations/postgres/008_workspace_query_indexes.sql', import.meta.url);
const expected = [
  ['idx_payouts_status_created', 'payouts(status, created_at DESC, id DESC)'],
  ['idx_payouts_seller_status', 'payouts(seller_id, status)'],
  ['idx_refunds_status_created', 'refunds(status, created_at DESC, id DESC)'],
  ['idx_refunds_order_status', 'refunds(order_id, status)'],
  ['idx_shipments_seller_order_created', 'shipments(seller_order_id, created_at DESC)'],
  ['idx_transactions_seller_kind_created', 'transactions(seller_id, kind, created_at DESC)'],
  ['idx_orders_status_created', 'orders(status, created_at DESC, id DESC)'],
  ['idx_seller_orders_order_status', 'seller_orders(order_id, status)'],
  ['idx_order_items_order', 'order_items(order_id)'],
  ['idx_order_events_order_created', 'order_events(order_id, created_at DESC)'],
  ['idx_products_category_status_created', 'products(category_id, status, created_at DESC)'],
  ['idx_products_brand_status', 'products(brand_id, status)'],
  ['idx_addresses_user', 'addresses(user_id)'],
  ['idx_notifications_user_read_created', 'notifications(user_id, read, created_at DESC)'],
  ['idx_reviews_product_created', 'reviews(product_id, created_at DESC)'],
  ['idx_audit_entity_created', 'audit_logs(entity, entity_id, created_at DESC)'],
  ['idx_audit_actor_created', 'audit_logs(actor_id, created_at DESC)'],
  ['idx_cart_items_product', 'cart_items(product_id)']
];

test('forward-only PostgreSQL workspace migration creates all expected bounded query indexes', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  for (const [name, target] of expected) {
    assert.ok(
      sql.includes('CREATE INDEX IF NOT EXISTS ' + name + ' ON ' + target + ';'),
      'Missing exact index definition: ' + name
    );
  }
  assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, expected.length);
  assert.match(sql, /^-- Query-path indexes for seller\/admin workspaces/m);
});

test('workspace index migration uses only tables and columns in the canonical PostgreSQL schema', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  const schema = await readFile(new URL('../apps/api/migrations/postgres/001_init.sql', import.meta.url), 'utf8');
  const indexedTables = ['payouts', 'refunds', 'shipments', 'transactions', 'orders', 'seller_orders',
    'order_items', 'order_events', 'products', 'addresses', 'notifications', 'reviews', 'audit_logs', 'cart_items'];
  for (const table of indexedTables) {
    assert.match(schema, new RegExp('CREATE TABLE IF NOT EXISTS ' + table + '\\('), 'Missing canonical table: ' + table);
  }
  assert.ok(sql.includes('idx_payouts_status_created'));
  assert.ok(sql.includes('idx_products_category_status_created'));
  assert.ok(sql.includes('idx_cart_items_product'));
});
