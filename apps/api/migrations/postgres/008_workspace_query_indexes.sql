-- Query-path indexes for seller/admin workspaces and order lifecycle.
-- This forward-only migration is extracted from the reviewed seller/admin workspace work.
-- It is additive and safe for existing PostgreSQL deployments with these base tables.
CREATE INDEX IF NOT EXISTS idx_payouts_status_created ON payouts(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_seller_status ON payouts(seller_id, status);
CREATE INDEX IF NOT EXISTS idx_refunds_status_created ON refunds(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_order_status ON refunds(order_id, status);
CREATE INDEX IF NOT EXISTS idx_shipments_seller_order_created ON shipments(seller_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_seller_kind_created ON transactions(seller_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_seller_orders_order_status ON seller_orders(order_id, status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_order_created ON order_events(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_category_status_created ON products(category_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_brand_status ON products(brand_id, status);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created ON notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_product_created ON reviews(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity_created ON audit_logs(entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_created ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cart_items_product ON cart_items(product_id);
