import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('PostgreSQL workspace query indexes cover payout, refund, order and seller access paths', async () => {
  const sql = await readFile(new URL('../apps/api/migrations/postgres/004_workspace_query_indexes.sql', import.meta.url), 'utf8');
  const expected = [
    'idx_payouts_status_created','idx_payouts_seller_status',
    'idx_refunds_status_created','idx_refunds_order_status',
    'idx_shipments_seller_order_created','idx_transactions_seller_kind_created',
    'idx_orders_status_created','idx_seller_orders_order_status',
    'idx_order_items_order','idx_order_events_order_created',
    'idx_products_category_status_created','idx_products_brand_status',
    'idx_addresses_user','idx_notifications_user_read_created',
    'idx_reviews_product_created','idx_audit_entity_created',
    'idx_audit_actor_created','idx_cart_items_product'
  ];
  for (const name of expected) assert.match(sql, new RegExp('CREATE INDEX IF NOT EXISTS '+name+'\\b'));
  assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, expected.length);
});
