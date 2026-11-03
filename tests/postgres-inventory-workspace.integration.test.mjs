import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, verifyPostgresConnection, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { createPostgresInventoryWorkspace } from '../apps/api/src/postgres-inventory-workspace.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = resolve(root, 'apps/api/migrations/postgres');

test('real PostgreSQL inventory approvals serialize concurrent decisions and produce audit, alerts and reports', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL inventory integration test not run'
}, async () => {
  const pool = await createPostgresPool({ env: { ...process.env, DATABASE_URL: databaseUrl } });
  const suffix = String(randomInt(10_000_000, 99_999_999));
  const sellerPhone = '017' + suffix;
  const adminPhone = '019' + suffix;
  let sellerId = null;
  let productId = null;
  let adminId = null;
  try {
    await verifyPostgresConnection(pool);
    await runPostgresMigrations(pool, migrationDirectory);
    const database = createPostgresDatabase(pool);
    const auth = createPostgresAuthRepository(database);
    const registered = await auth.registerSeller({
      name: 'Inventory Integration Seller',
      phone: sellerPhone,
      email: 'inventory-seller-' + suffix + '@example.test',
      password: 'Integration@123',
      confirm_password: 'Integration@123',
      shop_name: 'Inventory Integration Shop ' + suffix,
      shop_address: 'Dhaka',
      business_info: 'Disposable inventory integration fixture',
      kyc_nid: '1234567890123'
    });
    sellerId = registered.data.id;
    await pool.query("UPDATE seller_profiles SET status='APPROVED' WHERE user_id=$1", [sellerId]);
    adminId = randomUUID();
    await pool.query(`INSERT INTO users(id,phone,name,password,role,status,created_at)
      VALUES($1,$2,$3,$4,'ADMIN','ACTIVE',NOW()::text)`,
      [adminId, adminPhone, 'Inventory Integration Admin', 'integration-only-password']);
    productId = randomUUID();
    await pool.query(`INSERT INTO products
      (id,category_id,name_bn,name_en,price_paisa,stock,active,seller_id,status,created_at,updated_at)
      VALUES($1,NULL,$2,$3,12500,3,1,$4,'ACTIVE',NOW()::text,NOW()::text)`,
      [productId, 'ইন্টিগ্রেশন পণ্য ' + suffix, 'Integration Product ' + suffix, sellerId]);

    const workspace = createPostgresInventoryWorkspace(database);
    const request = await workspace.requestAdjustment({ id: sellerId, role: 'SELLER' }, productId, {
      delta: 4, reason: 'Verified incoming stock', idempotency_key: 'integration-' + suffix
    });
    assert.equal(request.status, 'PENDING');
    assert.equal(Number((await pool.query('SELECT stock FROM products WHERE id=$1', [productId])).rows[0].stock), 3,
      'a pending request must not mutate stock');
    const alertRows = await workspace.alerts({ sellerId, threshold: 5 });
    assert.ok(alertRows.some(row => row.id === productId), 'low-stock alert must include the fixture');
    const beforeReport = await workspace.report({ sellerId });
    assert.equal(Number(beforeReport.low_stock_products), 1);

    const decisions = await Promise.allSettled([
      workspace.decideRequest({ id: adminId, role: 'ADMIN' }, request.id, { decision: 'APPROVE', note: 'Count checked' }),
      workspace.decideRequest({ id: adminId, role: 'ADMIN' }, request.id, { decision: 'APPROVE', note: 'Duplicate approval attempt' })
    ]);
    assert.equal(decisions.filter(result => result.status === 'fulfilled').length, 1,
      'only one concurrent admin decision may commit');
    assert.equal(decisions.filter(result => result.status === 'rejected').length, 1);
    const finalStock = await pool.query('SELECT stock FROM products WHERE id=$1', [productId]);
    assert.equal(Number(finalStock.rows[0].stock), 7, 'stock must be adjusted exactly once');
    const movementRows = await workspace.movements(sellerId, productId);
    assert.equal(movementRows.length, 1);
    assert.equal(Number(movementRows[0].stock_after), 7);
    const report = await workspace.report({ sellerId });
    assert.equal(Number(report.movement_count), 1);
    assert.equal(Number(report.units_added), 4);
    assert.equal(Number(report.units_in_stock), 7);
  } finally {
    if (productId) {
      await pool.query('DELETE FROM inventory_adjustment_requests WHERE product_id=$1', [productId]);
      await pool.query('DELETE FROM inventory_movements WHERE product_id=$1', [productId]);
      await pool.query('DELETE FROM products WHERE id=$1', [productId]);
    }
    if (adminId) await pool.query('DELETE FROM users WHERE id=$1', [adminId]);
    if (sellerId) await pool.query('DELETE FROM users WHERE id=$1', [sellerId]);
    await closePostgresPool(pool);
  }
});
