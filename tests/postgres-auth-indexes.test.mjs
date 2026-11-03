import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationPath = new URL('../apps/api/migrations/postgres/005_auth_integrity_indexes.sql', import.meta.url);

test('auth integrity migration guards case-insensitive shop duplicates before adding unique index', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /GROUP BY lower\(shop_name\)/);
  assert.match(sql, /HAVING COUNT\(\*\) > 1/);
  assert.match(sql, /Resolve duplicates before retrying/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_profiles_shop_name_lower_unique/);
});

test('auth integrity migration indexes OTP lookup, session expiry and notification ordering', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /idx_otp_user_purpose_created[\s\S]*?WHERE used_at IS NULL/);
  assert.match(sql, /idx_sessions_expiry[\s\S]*?ON sessions\(expires_at\)/);
  assert.match(sql, /idx_notifications_user_created[\s\S]*?ON notifications\(user_id, created_at DESC\)/);
});
