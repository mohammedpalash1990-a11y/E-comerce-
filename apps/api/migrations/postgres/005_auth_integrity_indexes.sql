-- Protect seller shop-name uniqueness against case variants and speed up
-- the session/OTP/notification lookups used by the PostgreSQL auth repository.
DO $$
BEGIN
  IF EXISTS (
    SELECT lower(shop_name)
    FROM seller_profiles
    GROUP BY lower(shop_name)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add case-insensitive seller shop uniqueness: duplicate shop names differ only by case. Resolve duplicates before retrying.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_profiles_shop_name_lower_unique
  ON seller_profiles(lower(shop_name));
CREATE INDEX IF NOT EXISTS idx_otp_user_purpose_created
  ON otp_codes(user_id, purpose, created_at DESC, id DESC)
  WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_expiry
  ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);
