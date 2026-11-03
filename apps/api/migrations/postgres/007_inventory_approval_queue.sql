-- Seller inventory requests are reviewed by an administrator before stock changes.
CREATE TABLE IF NOT EXISTS inventory_adjustment_requests (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  seller_id TEXT NOT NULL REFERENCES seller_profiles(user_id) ON DELETE RESTRICT,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  quantity_delta BIGINT NOT NULL CHECK (quantity_delta <> 0 AND quantity_delta BETWEEN -20 AND 20),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 300),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  decision_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CONSTRAINT inventory_adjustment_requests_seller_idempotency UNIQUE (seller_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustment_requests_status_created
  ON inventory_adjustment_requests(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustment_requests_seller_created
  ON inventory_adjustment_requests(seller_id, created_at DESC, id DESC);
