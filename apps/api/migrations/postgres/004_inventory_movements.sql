-- Immutable audit trail for stock receipts, corrections, checkout reservations and cancellations.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  delta BIGINT NOT NULL CHECK (delta <> 0),
  stock_before BIGINT NOT NULL CHECK (stock_before >= 0),
  stock_after BIGINT NOT NULL CHECK (stock_after >= 0),
  reason TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reference TEXT,
  created_at TEXT NOT NULL,
  CHECK (stock_after = stock_before + delta)
);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_created
  ON inventory_movements(product_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference
  ON inventory_movements(reference) WHERE reference IS NOT NULL;
