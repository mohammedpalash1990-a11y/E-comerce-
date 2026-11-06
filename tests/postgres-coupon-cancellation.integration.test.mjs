import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { createPostgresPool, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresAuthRepository } from '../apps/api/src/postgres-auth.mjs';
import { createPostgresCartRepository } from '../apps/api/src/postgres-cart.mjs';
import { createPostgresCheckoutRepository } from '../apps/api/src/postgres-checkout.mjs';
import { createPostgresOrderLifecycleRepository } from '../apps/api/src/postgres-orders.mjs';
import { hashPassword } from '../apps/api/src/postgres-shared.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;

test('real PostgreSQL full parent cancellation restores coupon usage exactly once', {
  skip: !databaseUrl && 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL required',
  timeout: 30000
}, async () => {
  const pool = await createPostgresPool({
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, PG_APPLICATION_NAME: 'coupon-cancel-' + randomUUID() }
  });
  const userIds = [], productIds = [], couponCodes = [];
  try {
    await runPostgresMigrations(pool, new URL('../apps/api/migrations/postgres/', import.meta.url).pathname);
    const database = createPostgresDatabase(pool);
    const auth = createPostgresAuthRepository(database);
    const cart = createPostgresCartRepository(database);
    const timestamp = new Date().toISOString();
    const buyerId = randomUUID(), sellerId = randomUUID(), productId = randomUUID();
    const couponCode = 'CC' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
    userIds.push(buyerId, sellerId);
    productIds.push(productId);
    couponCodes.push(couponCode);
    const password = hashPassword('Disposable-coupon-cancel-123');
    const buyerPhone = '017' + randomInt(10000000, 99999999);
    const sellerPhone = '018' + randomInt(10000000, 99999999);
    await pool.query(
      'INSERT INTO users(id,phone,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [buyerId, buyerPhone, 'Coupon cancellation buyer', password, 'CUSTOMER', timestamp]
    );
    await pool.query(
      'INSERT INTO users(id,phone,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [sellerId, sellerPhone, 'Coupon cancellation seller', password, 'SELLER', timestamp]
    );
    await auth.createSession(buyerId);
    await pool.query(
      `INSERT INTO seller_profiles(user_id,shop_name,shop_address,status,commission_bps,created_at)
       VALUES($1,$2,'Disposable fixture address','APPROVED',0,$3)`,
      [sellerId, 'Coupon cancellation shop ' + sellerId, timestamp]
    );
    await pool.query(
      `INSERT INTO products(id,name_bn,name_en,price_paisa,stock,seller_id,created_at,updated_at)
       VALUES($1,'চা','Tea',2000,10,$2,$3,$3)`,
      [productId, sellerId, timestamp]
    );
    await pool.query(
      `INSERT INTO coupons(code,type,value,min_order_paisa,max_uses,used_count,expires_at,active)
       VALUES($1,'FIXED',500,0,NULL,0,NULL,1)`,
      [couponCode]
    );
    await cart.setItemQuantity(buyerId, productId, 1);
    const buyer = { id: buyerId, phone: buyerPhone };
    const checkout = createPostgresCheckoutRepository(database, { shippingFor: async () => 0 });
    const order = await checkout.checkout(buyer, {
      coupon_code: couponCode,
      delivery: { name: 'ক্রেতা', phone: buyerPhone, address: 'পরীক্ষার ঠিকানা', area: 'Dhaka' }
    });
    assert.equal(order.discount_bdt, 5);
    assert.equal(Number((await pool.query('SELECT used_count FROM coupons WHERE code=$1', [couponCode])).rows[0].used_count), 1);

    const lifecycle = createPostgresOrderLifecycleRepository(database);
    assert.equal(await lifecycle.applyParentStatus(order.id, 'CANCELLED', buyerId, 'Customer cancellation'), 'CANCELLED');
    const redemption = (await pool.query(
      'SELECT restored_at FROM coupon_redemptions WHERE order_id=$1',
      [order.id]
    )).rows[0];
    assert.ok(redemption?.restored_at, 'full cancellation must retain a durable restoration marker');
    assert.equal(Number((await pool.query('SELECT used_count FROM coupons WHERE code=$1', [couponCode])).rows[0].used_count), 0);

    await lifecycle.recomputeParent(order.id);
    assert.equal(Number((await pool.query('SELECT used_count FROM coupons WHERE code=$1', [couponCode])).rows[0].used_count), 0);
    assert.equal(
      (await pool.query('SELECT restored_at FROM coupon_redemptions WHERE order_id=$1', [order.id])).rows[0].restored_at,
      redemption.restored_at,
      'recomputing an already-cancelled parent must not restore the same redemption again'
    );
    await assert.rejects(
      lifecycle.applyParentStatus(order.id, 'CANCELLED', buyerId, 'Duplicate cancellation'),
      error => error.status === 409
    );
    assert.equal(Number((await pool.query('SELECT used_count FROM coupons WHERE code=$1', [couponCode])).rows[0].used_count), 0);
  } finally {
    try {
      if (userIds.length) await pool.query('DELETE FROM orders WHERE user_id=ANY($1::text[])', [userIds]);
      if (couponCodes.length) await pool.query('DELETE FROM coupons WHERE code=ANY($1::text[])', [couponCodes]);
      if (productIds.length) await pool.query('DELETE FROM products WHERE id=ANY($1::text[])', [productIds]);
      if (userIds.length) await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [userIds]);
    } finally {
      await closePostgresPool(pool);
    }
  }
});
