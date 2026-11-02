-- Immutable, seller-scoped inventory adjustment history.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  seller_id TEXT NOT NULL REFERENCES seller_profiles(user_id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  quantity_delta BIGINT NOT NULL CHECK (quantity_delta <> 0),
  stock_before BIGINT NOT NULL CHECK (stock_before >= 0),
  stock_after BIGINT NOT NULL CHECK (stock_after >= 0),
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT inventory_movements_stock_math CHECK (stock_after = stock_before + quantity_delta),
  CONSTRAINT inventory_movements_seller_idempotency UNIQUE (seller_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_created
  ON inventory_movements(product_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_seller_created
  ON inventory_movements(seller_id, created_at DESC, id DESC);
