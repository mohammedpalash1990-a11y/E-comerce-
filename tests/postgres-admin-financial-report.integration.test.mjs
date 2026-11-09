import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { createPostgresPool, closePostgresPool } from '../apps/api/src/postgres-pool.mjs';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { runPostgresMigrations } from '../apps/api/src/postgres-migrations.mjs';
import { registerPostgresAdminDashboardRoutes } from '../apps/api/src/postgres-admin-dashboard-routes.mjs';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const migrationDirectory = new URL('../apps/api/migrations/postgres/', import.meta.url).pathname;

test('admin financial report uses Dhaka calendar boundaries and isolates seller ledger, refunds and payouts', {
  skip: !databaseUrl && 'POSTGRES_TEST_DATABASE_URL is not configured; use a disposable PostgreSQL database',
  timeout: 30000
}, async () => {
  const env = { ...process.env, DATABASE_URL: databaseUrl, PGSSL_MODE: 'disable' };
  const pool = await createPostgresPool({ env });
  const database = createPostgresDatabase(pool);
  const customerId = randomUUID();
  const sellerA = randomUUID(), sellerB = randomUUID();
  const orderA = randomUUID(), orderB = randomUUID(), orderOutside = randomUUID();
  const sellerOrderA = randomUUID(), sellerOrderAOther = randomUUID(), sellerOrderB = randomUUID(), sellerOrderOutside = randomUUID();
  const ids = {
    transactions: [randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID()],
    refunds: [randomUUID(),randomUUID(),randomUUID()],
    payouts: [randomUUID(),randomUUID(),randomUUID(),randomUUID()]
  };
  const stamp = '2036-11-05T19:00:00.000Z';
  const phone = () => '017' + randomInt(10000000, 99999999);
  try {
    await runPostgresMigrations(pool, migrationDirectory);
    await pool.query(
      "INSERT INTO users(id,phone,name,password,role,status,created_at) VALUES($1,$2,'Report test customer','test-hash','CUSTOMER','ACTIVE',$3)",
      [customerId, phone(), stamp]
    );
    for (const [sellerId, shop] of [[sellerA,'Report test shop A ' + sellerA],[sellerB,'Report test shop B ' + sellerB]]) {
      await pool.query(
        "INSERT INTO users(id,phone,name,password,role,status,created_at) VALUES($1,$2,$3,'test-hash','SELLER','ACTIVE',$4)",
        [sellerId, phone(), shop, stamp]
      );
      await pool.query(
        "INSERT INTO seller_profiles(user_id,shop_name,shop_address,status,commission_bps,created_at) VALUES($1,$2,'Disposable fixture','APPROVED',800,$3)",
        [sellerId, shop, stamp]
      );
    }

    const orders = [
      [orderA,'2036-11-05T18:30:00.000Z',11000,10000,1500,500],
      [orderB,'2036-11-05T19:10:00.000Z',22000,20000,2000,0],
      [orderOutside,'2036-11-05T17:59:59.000Z',4400,4000,400,0]
    ];
    for (const [id,created,total,subtotal,shipping,discount] of orders) {
      await pool.query(
        `INSERT INTO orders(
          id,user_id,total_paisa,status,created_at,delivery_name,delivery_phone,delivery_address,delivery_area,
          subtotal_paisa,shipping_paisa,discount_paisa,payment_method,payment_status
        ) VALUES($1,$2,$3,'DELIVERED',$4,'Buyer',$5,'Test address','Dhaka',$6,$7,$8,'COD','PAID')`,
        [id,customerId,total,created,phone(),subtotal,shipping,discount]
      );
    }
    const sellerOrders = [
      [sellerOrderA,orderA,sellerA,6000,480,5520,300,'2036-11-05T18:31:00.000Z'],
      [sellerOrderAOther,orderA,sellerB,4000,320,3680,200,'2036-11-05T18:32:00.000Z'],
      [sellerOrderB,orderB,sellerB,20000,1600,18400,0,'2036-11-05T19:11:00.000Z'],
      [sellerOrderOutside,orderOutside,sellerA,4000,320,3680,0,'2036-11-05T17:59:59.000Z']
    ];
    for (const [id,orderId,sellerId,subtotal,commission,net,couponDiscount,created] of sellerOrders) {
      await pool.query(
        `INSERT INTO seller_orders(
          id,order_id,seller_id,status,subtotal_paisa,created_at,commission_paisa,net_paisa,coupon_discount_paisa
        ) VALUES($1,$2,$3,'DELIVERED',$4,$5,$6,$7,$8)`,
        [id,orderId,sellerId,subtotal,created,commission,net,couponDiscount]
      );
    }

    const ledger = [
      [ids.transactions[0],'COMMISSION',orderA,sellerOrderA,sellerA,480,'commission:' + sellerOrderA,'2036-11-05T19:00:00.000Z'],
      [ids.transactions[1],'SELLER_EARNING',orderA,sellerOrderA,sellerA,5520,'earning:' + sellerOrderA,'2036-11-05T19:00:00.000Z'],
      [ids.transactions[2],'COMMISSION',orderA,sellerOrderAOther,sellerB,320,'commission:' + sellerOrderAOther,'2036-11-05T19:00:00.000Z'],
      [ids.transactions[3],'SELLER_EARNING',orderA,sellerOrderAOther,sellerB,3680,'earning:' + sellerOrderAOther,'2036-11-05T19:00:00.000Z'],
      [ids.transactions[4],'COMMISSION',orderB,sellerOrderB,sellerB,1600,'commission:' + sellerOrderB,'2036-11-05T19:10:00.000Z'],
      [ids.transactions[5],'SELLER_EARNING',orderB,sellerOrderB,sellerB,18400,'earning:' + sellerOrderB,'2036-11-05T19:10:00.000Z'],
      [ids.transactions[6],'COMMISSION',orderOutside,sellerOrderOutside,sellerA,320,'commission:' + sellerOrderOutside,'2036-11-05T17:59:59.000Z'],
      [ids.transactions[7],'SELLER_EARNING',orderOutside,sellerOrderOutside,sellerA,3680,'earning:' + sellerOrderOutside,'2036-11-05T17:59:59.000Z']
    ];
    for (const [id,kind,orderId,sellerOrderId,sellerId,amount,ref,created] of ledger) {
      await pool.query(
        'INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id,kind,orderId,sellerOrderId,sellerId,amount,ref,created]
      );
    }
    const refunds = [
      [ids.refunds[0],orderA,300,'REQUESTED','2036-11-05T19:02:00.000Z'],
      [ids.refunds[1],orderB,400,'REQUESTED','2036-11-05T19:12:00.000Z'],
      [ids.refunds[2],orderOutside,500,'REQUESTED','2036-11-05T17:59:59.000Z']
    ];
    for (const [id,orderId,amount,status,created] of refunds) {
      await pool.query(
        'INSERT INTO refunds(id,order_id,amount_paisa,reason,status,created_at,decided_at) VALUES($1,$2,$3,$4,$5,$6,NULL)',
        [id,orderId,amount,'Report fixture',status,created]
      );
    }
    const payouts = [
      [ids.payouts[0],sellerA,1000,'REQUESTED','2036-11-05T19:03:00.000Z'],
      [ids.payouts[1],sellerA,2000,'APPROVED','2036-11-05T19:04:00.000Z'],
      [ids.payouts[2],sellerA,500,'REJECTED','2036-11-05T17:59:59.000Z'],
      [ids.payouts[3],sellerB,3000,'REQUESTED','2036-11-05T19:13:00.000Z']
    ];
    for (const [id,sellerId,amount,status,created] of payouts) {
      await pool.query(
        'INSERT INTO payouts(id,seller_id,amount_paisa,method,account,status,note,created_at,decided_at) VALUES($1,$2,$3,\'BKASH\',\'test-account\',$4,\'fixture\',$5,NULL)',
        [id,sellerId,amount,status,created]
      );
    }

    const routes = [];
    registerPostgresAdminDashboardRoutes(
      (method,path,roles,handler) => routes.push({method,path,roles,handler}),
      (data,status=200) => ({status,body:{data}}),
      { database }
    );
    const handler = routes.find(route => route.path === '/api/v1/admin/reports/summary').handler;
    const all = (await handler({url:new URL('https://api.example.test/api/v1/admin/reports/summary?from=2036-11-06&to=2036-11-06')})).body.data;
    assert.deepEqual(all.orders,{total:2,paid:2,cancelled:0,unpaid_cod:0});
    assert.deepEqual(all.sales,{
      gross_merchandise:{paisa:30000,bdt:300},
      discounts:{paisa:500,bdt:5},
      net_merchandise:{paisa:29500,bdt:295},
      shipping:{paisa:3500,bdt:35}
    });
    assert.deepEqual(all.finance,{
      platform_commission:{paisa:2400,bdt:24},
      seller_earnings:{paisa:27600,bdt:276},
      seller_reversals:{paisa:0,bdt:0}
    });
    assert.deepEqual(all.refunds,{requested_count:2,requested_amount:{paisa:700,bdt:7}});
    assert.deepEqual(all.payouts,{
      requested_count:2,requested_amount:{paisa:4000,bdt:40},
      approved_count:1,approved_amount:{paisa:2000,bdt:20},
      rejected_count:0,rejected_amount:{paisa:0,bdt:0}
    });

    const scoped = (await handler({url:new URL('https://api.example.test/api/v1/admin/reports/summary?from=2036-11-06&to=2036-11-06&seller_id=' + sellerA)})).body.data;
    assert.deepEqual(scoped.orders,{total:1,paid:1,cancelled:0,unpaid_cod:0});
    assert.deepEqual(scoped.sales,{
      gross_merchandise:{paisa:6000,bdt:60},
      discounts:{paisa:300,bdt:3},
      net_merchandise:{paisa:5700,bdt:57},
      shipping:null
    });
    assert.deepEqual(scoped.finance,{
      platform_commission:{paisa:480,bdt:4.8},
      seller_earnings:{paisa:5520,bdt:55.2},
      seller_reversals:{paisa:0,bdt:0}
    });
    assert.equal(scoped.refunds,null,'parent-order refund must not be double-attributed to seller A');
    const scopedOtherSeller = (await handler({url:new URL('https://api.example.test/api/v1/admin/reports/summary?from=2036-11-06&to=2036-11-06&seller_id=' + sellerB)})).body.data;
    assert.deepEqual(scopedOtherSeller.orders,{total:2,paid:2,cancelled:0,unpaid_cod:0});
    assert.equal(scopedOtherSeller.refunds,null,'the same parent-order refund must not be attributed to seller B either');
    assert.deepEqual(scoped.payouts,{
      requested_count:1,requested_amount:{paisa:1000,bdt:10},
      approved_count:1,approved_amount:{paisa:2000,bdt:20},
      rejected_count:0,rejected_amount:{paisa:0,bdt:0}
    });
  } finally {
    await pool.query('DELETE FROM refunds WHERE id=ANY($1::text[])',[ids.refunds]);
    await pool.query('DELETE FROM transactions WHERE id=ANY($1::text[])',[ids.transactions]);
    await pool.query('DELETE FROM payouts WHERE id=ANY($1::text[])',[ids.payouts]);
    await pool.query('DELETE FROM seller_orders WHERE id=ANY($1::text[])',[[sellerOrderA,sellerOrderAOther,sellerOrderB,sellerOrderOutside]]);
    await pool.query('DELETE FROM orders WHERE id=ANY($1::text[])',[[orderA,orderB,orderOutside]]);
    await pool.query('DELETE FROM seller_profiles WHERE user_id=ANY($1::text[])',[[sellerA,sellerB]]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])',[[customerId,sellerA,sellerB]]);
    await closePostgresPool(pool);
  }
});
