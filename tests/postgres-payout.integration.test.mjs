import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { registerPostgresPayoutRoutes } from '../apps/api/src/postgres-payout-routes.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = resolve(root, 'apps/api/migrations/postgres');

test('real PostgreSQL payout requests serialize against seller balance and admin approvals', {
  skip: databaseUrl ? false : 'POSTGRES_TEST_DATABASE_URL is not configured; disposable PostgreSQL payout integration test not run',
  timeout: 30000
}, async () => {
  const pool = await createPostgresPool({
    env: { ...process.env, DATABASE_URL: databaseUrl, PG_SSL_MODE: 'disable', PGSSL_MODE: 'disable' }
  });
  const sellerId = randomUUID(), adminId = randomUUID();
  const stamp = new Date().toISOString();
  const suffix = String(randomInt(10_000_000, 99_999_999));
  const routes = [];
  const database = createPostgresDatabase(pool);
  const find = (method, path) => routes.find(route => route.method === method && route.path === path);
  try {
    await runPostgresMigrations(pool, migrationDirectory);
    await pool.query(
      'INSERT INTO users(id,phone,name,password,role,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [sellerId, '017' + suffix, 'Payout integration seller', 'integration-only-hash', 'SELLER', 'ACTIVE', stamp]
    );
    await pool.query(
      'INSERT INTO users(id,phone,name,password,role,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [adminId, '019' + suffix, 'Payout integration admin', 'integration-only-hash', 'ADMIN', 'ACTIVE', stamp]
    );
    await pool.query(
      "INSERT INTO seller_profiles(user_id,shop_name,shop_address,status,commission_bps,created_at) VALUES($1,$2,$3,'APPROVED',800,$4)",
      [sellerId, 'Payout integration shop ' + suffix, 'Disposable fixture', stamp]
    );
    await pool.query(
      "INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES($1,'SELLER_EARNING',NULL,NULL,$2,10000,$3,$4)",
      [randomUUID(), sellerId, 'payout-fixture-' + suffix, stamp]
    );

    registerPostgresPayoutRoutes(
      (method, path, roles, handler) => routes.push({ method, path, roles, handler }),
      (data, status = 200) => ({ status, body: { data } }),
      { database, id: randomUUID, now: () => new Date().toISOString() }
    );

    const request = amount_bdt => find('POST', '/api/v1/seller/payouts').handler({
      user: { id: sellerId, role: 'SELLER' },
      body: { amount_bdt, method: 'BKASH', account: '01700000000' }
    });
    const competingRequests = await Promise.allSettled([request(70), request(70)]);
    assert.equal(competingRequests.filter(result => result.status === 'fulfilled').length, 1,
      'only one concurrent 70 BDT request may reserve a 100 BDT seller balance');
    assert.equal(competingRequests.filter(result => result.status === 'rejected').length, 1);
    const requestedRows = await pool.query(
      "SELECT id,amount_paisa,status FROM payouts WHERE seller_id=$1 AND status='REQUESTED'",
      [sellerId]
    );
    assert.equal(requestedRows.rows.length, 1);
    assert.equal(Number(requestedRows.rows[0].amount_paisa), 7000);

    const decision = (id, decision) => find('POST', '/api/v1/admin/payouts/:id/decision').handler({
      user: { id: adminId, role: 'ADMIN' },
      params: [id],
      body: { decision, note: 'Integration verified' }
    });
    const approved = await decision(requestedRows.rows[0].id, 'APPROVE');
    assert.equal(approved.body.data.status, 'APPROVED');

    const availableAfterApproval = await pool.query(`SELECT
      (SELECT COALESCE(SUM(amount_paisa),0) FROM transactions
        WHERE seller_id=$1 AND kind IN ('SELLER_EARNING','SELLER_REVERSAL')) -
      (SELECT COALESCE(SUM(amount_paisa),0) FROM payouts
        WHERE seller_id=$1 AND status IN ('REQUESTED','APPROVED')) AS available`,
      [sellerId]
    );
    assert.equal(Number(availableAfterApproval.rows[0].available), 3000);

    const excessPayoutId = randomUUID();
    await pool.query(
      "INSERT INTO payouts(id,seller_id,amount_paisa,method,account,status,note,created_at) VALUES($1,$2,4000,'BKASH','01700000000','REQUESTED','', $3)",
      [excessPayoutId, sellerId, stamp]
    );
    await assert.rejects(decision(excessPayoutId, 'APPROVE'), error => error.status === 409,
      'approval must fail when all pending and approved reservations exceed earned balance');
    const excessState = await pool.query('SELECT status FROM payouts WHERE id=$1', [excessPayoutId]);
    assert.equal(excessState.rows[0].status, 'REQUESTED');

    const audit = await pool.query(
      "SELECT COUNT(*)::int count FROM audit_logs WHERE entity='payout' AND entity_id=$1 AND action='PAYOUT_APPROVED'",
      [requestedRows.rows[0].id]
    );
    assert.equal(audit.rows[0].count, 1);
    const sellerNotifications = await pool.query(
      "SELECT COUNT(*)::int count FROM notifications WHERE user_id=$1 AND title IN ('পেআউট সম্পন্ন','পেআউট প্রত্যাখ্যাত')",
      [sellerId]
    );
    assert.equal(sellerNotifications.rows[0].count, 1);
  } finally {
    await pool.query('DELETE FROM transactions WHERE seller_id=$1', [sellerId]);
    await pool.query('DELETE FROM payouts WHERE seller_id=$1', [sellerId]);
    await pool.query("DELETE FROM audit_logs WHERE actor_id=ANY($1::text[]) OR entity_id=$2", [[sellerId, adminId], sellerId]);
    await pool.query('DELETE FROM notifications WHERE user_id=ANY($1::text[])', [[sellerId, adminId]]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[sellerId, adminId]]);
    await closePostgresPool(pool);
  }
});
