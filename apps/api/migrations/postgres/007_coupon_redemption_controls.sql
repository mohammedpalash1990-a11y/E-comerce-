-- Additive coupon redemption controls. Existing coupons remain unlimited per customer
-- unless an administrator explicitly sets max_uses_per_customer.
ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS max_uses_per_customer BIGINT
  CHECK (max_uses_per_customer IS NULL OR max_uses_per_customer > 0);

-- Keep the per-seller share of the parent discount for settlement/reporting.
-- This is attribution only; it does not silently change seller commission/net.
ALTER TABLE seller_orders
  ADD COLUMN IF NOT EXISTS coupon_discount_paisa BIGINT NOT NULL DEFAULT 0
  CHECK (coupon_discount_paisa >= 0);

-- One durable redemption record per coupon/order. restored_at makes cancellation
-- reversal idempotent while retaining the audit trail.
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id TEXT PRIMARY KEY,
  coupon_code TEXT NOT NULL REFERENCES coupons(code),
  user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  discount_paisa BIGINT NOT NULL CHECK (discount_paisa >= 0),
  created_at TEXT NOT NULL,
  restored_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_customer_active
  ON coupon_redemptions(coupon_code, user_id) WHERE restored_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_order
  ON coupon_redemptions(order_id);
