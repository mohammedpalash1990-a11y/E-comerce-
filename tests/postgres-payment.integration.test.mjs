import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { createPostgresPool, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresPaymentRepository } from '../apps/api/src/postgres-payment-routes.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const migrationDirectory = new URL('../apps/api/migrations/postgres/', import.meta.url).pathname;

test('real PostgreSQL payment initiation, signed-result persistence and duplicate callback idempotency', {
  skip: !databaseUrl && 'POSTGRES_TEST_DATABASE_URL is not configured; use a disposable PostgreSQL database',
  timeout: 30000
}, async () => {
  const env = { ...process.env, DATABASE_URL: databaseUrl, PG_SSL_MODE: 'disable', PGSSL_MODE: 'disable' };
  const pool = await createPostgresPool({ env });
  const customerId = randomUUID(), sellerId = randomUUID(), orderId = randomUUID();
  const sellerOrderId = randomUUID(), paymentId = randomUUID();
  const stamp = new Date().toISOString();
  const amount = 18750;
  const gatewayTxnId = 'SBX-BKASH-' + randomUUID();
  try {
    await runPostgresMigrations(pool, migrationDirectory);
    const phone = '017' + randomInt(10000000, 99999999);
    await pool.query(
      'INSERT INTO users(id,phone,name,password,role,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [customerId, phone, 'Payment integration customer', 'test-only-password-hash', 'CUSTOMER', 'ACTIVE', stamp]
    );
    await pool.query(
      'INSERT INTO users(id,phone,name,password,role,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [sellerId, '018' + randomInt(10000000, 99999999), 'Payment integration seller', 'test-only-password-hash', 'SELLER', 'ACTIVE', stamp]
    );
    await pool.query(
      "INSERT INTO seller_profiles(user_id,shop_name,shop_address,status,commission_bps,created_at) VALUES($1,$2,$3,'APPROVED',800,$4)",
      [sellerId, 'Payment test shop ' + sellerId, 'Disposable fixture', stamp]
    );
    await pool.query(
      `INSERT INTO orders(id,user_id,total_paisa,status,created_at,delivery_name,delivery_phone,delivery_address,delivery_area,subtotal_paisa,shipping_paisa,discount_paisa,payment_method,payment_status)
       VALUES($1,$2,$3,'AWAITING_PAYMENT',$4,'Buyer',$5,'Test address','Dhaka',$3,0,0,'BKASH','PENDING')`,
      [orderId, customerId, amount, stamp, phone]
    );
    await pool.query(
      "INSERT INTO seller_orders(id,order_id,seller_id,status,subtotal_paisa,created_at,commission_paisa,net_paisa) VALUES($1,$2,$3,'AWAITING_PAYMENT',$4,$5,1500,17250)",
      [sellerOrderId, orderId, sellerId, amount, stamp]
    );
    await pool.query(
      "INSERT INTO payments(id,order_id,method,amount_paisa,status,gateway_txn_id,raw,created_at,updated_at) VALUES($1,$2,'BKASH',$3,'PENDING',NULL,'{}',$4,$4)",
      [paymentId, orderId, amount, stamp]
    );

    const database = createPostgresDatabase(pool);
    let gatewayCalls = 0;
    const payments = createPostgresPaymentRepository(database, {
      id: randomUUID,
      now: () => new Date().toISOString(),
      gatewayInitiate: async (method, payment) => {
        gatewayCalls++;
        assert.equal(method, 'BKASH');
        assert.equal(payment.id, paymentId);
        assert.equal(payment.total_paisa, amount);
        return {
          gatewayTxnId,
          redirectUrl: '/api/v1/payments/sandbox/' + paymentId + '/simulate',
          sandbox: true
        };
      }
    });

    await assert.rejects(
      payments.prepareCustomerPayment({ userId: sellerId, orderId, method: 'BKASH' }),
      error => error.status === 404
    );
    const prepared = await payments.prepareCustomerPayment({ userId: customerId, orderId, method: 'BKASH' });
    assert.deepEqual(prepared, { id: paymentId, method: 'BKASH' });

    const initiated = await payments.initiatePayment({ userId: customerId, paymentId, method: 'BKASH', amountPaisa: amount });
    assert.equal(initiated.status, 'INITIATED');
    assert.equal(initiated.gateway_txn_id, gatewayTxnId);
    assert.equal(initiated.sandbox, true);
    assert.equal(gatewayCalls, 1);

    await assert.rejects(
      payments.recordVerifiedPaymentCallback({ method: 'BKASH', gatewayTxnId, amountPaisa: amount - 1, status: 'SUCCESS' }),
      error => error.status === 400
    );

    const paid = await payments.recordVerifiedPaymentCallback({
      method: 'BKASH', gatewayTxnId, amountPaisa: amount, status: 'SUCCESS'
    });
    assert.deepEqual(paid, { duplicate: false, status: 'PAID' });

    const rows = await pool.query(
      `SELECT p.status payment_status,o.status order_status,o.payment_status order_payment_status,
              so.status seller_status
       FROM payments p JOIN orders o ON o.id=p.order_id
       JOIN seller_orders so ON so.order_id=o.id
       WHERE p.id=$1`,
      [paymentId]
    );
    assert.deepEqual(rows.rows[0], {
      payment_status: 'PAID',
      order_status: 'CONFIRMED',
      order_payment_status: 'PAID',
      seller_status: 'CONFIRMED'
    });

    const ledger = await pool.query(
      "SELECT kind,amount_paisa,ref FROM transactions WHERE order_id=$1 AND kind='ORDER_PAYMENT'",
      [orderId]
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(Number(ledger.rows[0].amount_paisa), amount);
    assert.equal(ledger.rows[0].ref, paymentId);

    const duplicate = await payments.recordVerifiedPaymentCallback({
      method: 'BKASH', gatewayTxnId, amountPaisa: amount, status: 'SUCCESS'
    });
    assert.deepEqual(duplicate, { duplicate: true, status: 'PAID' });
    const finalLedger = await pool.query(
      "SELECT COUNT(*)::int AS count FROM transactions WHERE order_id=$1 AND kind='ORDER_PAYMENT'",
      [orderId]
    );
    assert.equal(finalLedger.rows[0].count, 1);

    const event = await pool.query(
      "SELECT status FROM order_events WHERE order_id=$1 AND status='PAYMENT_CONFIRMED'",
      [orderId]
    );
    assert.equal(event.rows.length, 1);
    const notifications = await pool.query('SELECT user_id FROM notifications WHERE user_id=ANY($1::text[])', [[customerId, sellerId]]);
    assert.deepEqual(new Set(notifications.rows.map(row => row.user_id)), new Set([customerId, sellerId]));
  } finally {
    try {
      await pool.query('DELETE FROM orders WHERE id=$1', [orderId]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[customerId, sellerId]]);
    } finally {
      await closePostgresPool(pool);
    }
  }
});
