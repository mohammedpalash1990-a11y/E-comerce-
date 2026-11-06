import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, verifyPostgresConnection, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { registerPostgresAdminProductRoutes } from '../apps/api/src/postgres-admin-product-routes.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = resolve(root, 'apps/api/migrations/postgres');

test('real PostgreSQL admin product moderation serializes competing decisions and enforces seller approval', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL moderation integration test not run'
}, async () => {
  const pool = await createPostgresPool({ env: { ...process.env, DATABASE_URL: databaseUrl } });
  const suffix = String(randomInt(10_000_000, 99_999_999));
  const adminId = randomUUID();
  const productId = randomUUID();
  const blockedProductId = randomUUID();
  let sellerId = null;
  let blockedSellerId = null;
  try {
    await verifyPostgresConnection(pool);
    await runPostgresMigrations(pool, migrationDirectory);
    const database = createPostgresDatabase(pool);
    const auth = createPostgresAuthRepository(database);
    const register = async (prefix, phone, email, nid) => {
      const result = await auth.registerSeller({
        name: prefix + ' Moderation Seller', phone, email,
        password: 'Integration@123', confirm_password: 'Integration@123',
        shop_name: prefix + ' Moderation Shop ' + suffix, shop_address: 'Dhaka',
        business_info: 'Disposable admin moderation fixture', kyc_nid: nid
      });
      return result.data.id;
    };
    sellerId = await register('Approved', '017' + suffix, 'moderation-' + suffix + '@example.test', '1234567890123');
    blockedSellerId = await register('Unapproved', '018' + suffix, 'moderation-blocked-' + suffix + '@example.test', '1234567890124');
    await pool.query("UPDATE seller_profiles SET status='APPROVED' WHERE user_id=$1", [sellerId]);
    await pool.query('INSERT INTO users(id,phone,name,password,role,status,created_at) VALUES($1,$2,$3,$4,\'ADMIN\',\'ACTIVE\',NOW()::text)',
      [adminId, '019' + suffix, 'Moderation Admin', 'integration-only-password']);
    await pool.query(`INSERT INTO products
      (id,category_id,name_bn,name_en,price_paisa,stock,active,seller_id,status,created_at,updated_at)
      VALUES($1,NULL,$2,$3,9900,5,0,$4,'PENDING_REVIEW',NOW()::text,NOW()::text),
            ($5,NULL,$6,$7,9900,5,0,$8,'PENDING_REVIEW',NOW()::text,NOW()::text)`,
      [productId, 'মডারেশন পণ্য ' + suffix, 'Moderation Product ' + suffix, sellerId,
        blockedProductId, 'অঅনুমোদিত পণ্য ' + suffix, 'Unapproved Seller Product ' + suffix, blockedSellerId]);

    const routes = [];
    registerPostgresAdminProductRoutes((method, path, roles, handler) => routes.push({ method, path, roles, handler }),
      (data, status = 200) => ({ status, body: { data } }), { database });
    const admin = { id: adminId, role: 'ADMIN' };
    const approve = routes.find(route => route.path === '/api/v1/admin/products/:id/approve').handler;
    const reject = routes.find(route => route.path === '/api/v1/admin/products/:id/reject').handler;
    const decisions = await Promise.allSettled([
      approve({ user: admin, params: [productId], body: { reason: 'Approval race' } }),
      reject({ user: admin, params: [productId], body: { reason: 'Rejection race' } })
    ]);
    assert.equal(decisions.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(decisions.filter(result => result.status === 'rejected').length, 1);
    const product = await pool.query('SELECT status,active FROM products WHERE id=$1', [productId]);
    assert.ok(['ACTIVE', 'REJECTED'].includes(product.rows[0].status));
    assert.equal(Number(product.rows[0].active), product.rows[0].status === 'ACTIVE' ? 1 : 0);
    const audit = await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE entity='product' AND entity_id=$1", [productId]);
    assert.equal(audit.rows[0].count, 1);
    const notification = await pool.query("SELECT COUNT(*)::int AS count FROM notifications WHERE user_id=$1 AND title LIKE 'পণ্যের স্ট্যাটাস:%'", [sellerId]);
    assert.equal(notification.rows[0].count, 1);

    await assert.rejects(
      approve({ user: admin, params: [blockedProductId], body: { reason: 'Must remain blocked' } }),
      error => error?.status === 409
    );
    const blocked = await pool.query('SELECT status,active FROM products WHERE id=$1', [blockedProductId]);
    assert.equal(blocked.rows[0].status, 'PENDING_REVIEW');
    assert.equal(Number(blocked.rows[0].active), 0);
    const blockedAudit = await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE entity='product' AND entity_id=$1", [blockedProductId]);
    assert.equal(blockedAudit.rows[0].count, 0);
  } finally {
    await closePostgresPool(pool);
  }
});
