import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, verifyPostgresConnection, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresInventoryRepository } from '../apps/api/src/postgres-inventory.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = resolve(root, 'apps/api/migrations/postgres');

test('real PostgreSQL seller stock adjustments are idempotent, serialized and ownership-safe', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL inventory integration test not run'
}, async () => {
  const pool = await createPostgresPool({ env: { ...process.env, DATABASE_URL: databaseUrl } });
  const suffix = String(randomInt(10_000_000, 99_999_999));
  const sellerPhone = '017' + suffix;
  const otherSellerPhone = '018' + suffix;
  const seller = { id: null, role: 'SELLER' };
  const otherSeller = { id: null, role: 'SELLER' };
  const productId = randomUUID();
  const emptyProductId = randomUUID();

  try {
    await verifyPostgresConnection(pool);
    await runPostgresMigrations(pool, migrationDirectory);
    const database = createPostgresDatabase(pool);
    const createdAt = new Date().toISOString();
    for (const [target, phone, label] of [
      [seller, sellerPhone, 'Primary'],
      [otherSeller, otherSellerPhone, 'Other']
    ]) {
      target.id = randomUUID();
      await pool.query(
        'INSERT INTO users(id,phone,name,password,role,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [target.id, phone, label + ' Inventory Integration Seller', 'integration-only-password', 'SELLER', 'ACTIVE', createdAt]
      );
      await pool.query(
        `INSERT INTO seller_profiles(user_id,shop_name,shop_address,business_info,kyc_nid,status,commission_bps,created_at)
         VALUES($1,$2,'Dhaka','Disposable inventory idempotency fixture',$3,'APPROVED',0,$4)`,
        [target.id, label + ' Inventory Integration Shop ' + suffix,
          label === 'Primary' ? '1234567890123' : '1234567890124', createdAt]
      );
    }

    await pool.query(`INSERT INTO products
      (id,category_id,name_bn,name_en,price_paisa,stock,active,seller_id,status,created_at,updated_at)
      VALUES($1,NULL,$2,$3,12500,5,1,$4,'ACTIVE',NOW()::text,NOW()::text),
            ($5,NULL,$6,$7,12500,0,1,$4,'ACTIVE',NOW()::text,NOW()::text)`,
      [productId, 'ইন্টিগ্রেশন পণ্য ' + suffix, 'Inventory Idempotency Product ' + suffix,
        seller.id, emptyProductId, 'শূন্য স্টক পণ্য ' + suffix, 'Empty Stock Product ' + suffix]);

    const inventory = createPostgresInventoryRepository(database);
    const sameKey = 'inventory-same-key-' + suffix;
    const duplicates = await Promise.all([
      inventory.adjustSellerStock(seller, productId, {
        delta: 2, reason: 'Concurrent retry A', idempotencyKey: sameKey
      }),
      inventory.adjustSellerStock(seller, productId, {
        delta: 2, reason: 'Concurrent retry B', idempotencyKey: sameKey
      })
    ]);
    assert.equal(duplicates.filter(row => row.duplicate === false).length, 1,
      'exactly one request with the same idempotency key must apply');
    assert.equal(duplicates.filter(row => row.duplicate === true).length, 1,
      'the concurrent retry must return the committed movement');

    const distinct = await Promise.all([
      inventory.adjustSellerStock(seller, productId, {
        delta: 3, reason: 'Concurrent distinct adjustment A', idempotencyKey: 'inventory-distinct-a-' + suffix
      }),
      inventory.adjustSellerStock(seller, productId, {
        delta: -1, reason: 'Concurrent distinct adjustment B', idempotencyKey: 'inventory-distinct-b-' + suffix
      })
    ]);
    assert.equal(distinct.every(row => row.duplicate === false), true);
    const stock = await pool.query('SELECT stock FROM products WHERE id=$1', [productId]);
    assert.equal(Number(stock.rows[0].stock), 9,
      'row locking must serialize distinct adjustments without losing either delta');

    const movements = await inventory.listMovements(seller.id, productId);
    assert.equal(movements.length, 3, 'one same-key movement plus both distinct movements must be recorded');
    const audits = await pool.query(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE actor_id=$1 AND entity='product' AND entity_id=$2",
      [seller.id, productId]
    );
    assert.equal(audits.rows[0].count, 3, 'each committed stock movement must have one audit entry');

    await assert.rejects(
      inventory.adjustSellerStock(otherSeller, productId, {
        delta: 1, reason: 'Cross-seller access attempt', idempotencyKey: 'inventory-owner-check-' + suffix
      }),
      error => error?.status === 404,
      'a seller must not adjust another seller product'
    );
    await assert.rejects(
      inventory.adjustSellerStock(seller, emptyProductId, {
        delta: -1, reason: 'Invalid negative stock', idempotencyKey: 'inventory-underflow-' + suffix
      }),
      error => error?.status === 409,
      'stock must never become negative'
    );
    const emptyMovement = await inventory.listMovements(seller.id, emptyProductId);
    assert.equal(emptyMovement.length, 0, 'a rejected underflow must not leave a movement record');
    const emptyStock = await pool.query('SELECT stock FROM products WHERE id=$1', [emptyProductId]);
    assert.equal(Number(emptyStock.rows[0].stock), 0);
  } finally {
    await pool.query('DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])', [[productId, emptyProductId]]);
    await pool.query('DELETE FROM inventory_movements WHERE product_id = ANY($1::text[])', [[productId, emptyProductId]]);
    await pool.query('DELETE FROM products WHERE id = ANY($1::text[])', [[productId, emptyProductId]]);
    for (const id of [seller.id, otherSeller.id].filter(Boolean)) {
      await pool.query('DELETE FROM users WHERE id=$1', [id]);
    }
    await closePostgresPool(pool);
  }
});
