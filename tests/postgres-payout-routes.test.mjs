import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresPayoutRoutes } from '../apps/api/src/postgres-payout-routes.mjs';

function setup({ seller = { status: 'APPROVED', account_status: 'ACTIVE' }, earned = 100000, reserved = 10000, payout = { id: 'pay-1', seller_id: 'seller-1', amount_paisa: 5000, status: 'REQUESTED' } } = {}) {
  const routes = [], calls = [];
  const database = {
    q(sql) {
      return {
        async get(...args) {
          calls.push({ method: 'get', sql, args });
          if (sql.includes('FROM seller_profiles sp JOIN users')) return seller;
          if (sql.includes('SELECT seller_id FROM payouts WHERE id=?')) return { seller_id: payout.seller_id };
          if (sql.includes('FROM seller_profiles WHERE user_id=? FOR UPDATE')) return { user_id: payout.seller_id };
          if (sql.includes('FROM payouts WHERE id=? FOR UPDATE')) return payout;
          if (sql.includes('AS sales')) return { sales: 20000, commission: 1600, earned, pending: 10000, paid: 5000 };
          if (sql.includes('AS reserved')) return { earned, reserved };
          if (sql.includes('AS earned')) return { earned, reserved };
          return undefined;
        },
        async all(...args) {
          calls.push({ method: 'all', sql, args });
          if (sql.includes('FROM transactions WHERE seller_id')) return [{ kind: 'SELLER_EARNING', amount_paisa: 10000, created_at: '2026-11-03', seller_order_id: 'so-1' }];
          if (sql.includes('FROM payouts WHERE seller_id')) return [{ id: 'pay-1', amount_paisa: 5000, method: 'BKASH', account: '01700000000', status: 'REQUESTED', note: '', created_at: '2026-11-03' }];
          if (sql.includes('FROM users WHERE role=\'ADMIN\'')) return [{ id: 'admin-1' }];
          if (sql.includes('FROM payouts p JOIN seller_profiles')) return [{ id: 'pay-1', seller_id: 'seller-1', amount_paisa: 5000, method: 'BKASH', account: '01700000000', status: 'REQUESTED', shop_name: 'Tea Shop' }];
          return [];
        },
        async run(...args) { calls.push({ method: 'run', sql, args }); return { changes: 1, rows: [] }; }
      };
    },
    async tx(fn) { calls.push({ method: 'tx' }); return fn(); }
  };
  registerPostgresPayoutRoutes((method,path,roles,handler)=>routes.push({method,path,roles,handler}),
    (data,status=200)=>({status,body:{data}}),{database,id:()=> 'generated-id',now:()=> '2026-11-03T00:00:00.000Z'});
  return { routes, calls };
}
const find=(h,method,path)=>h.routes.find(x=>x.method===method&&x.path===path);
const sellerUser={id:'seller-1',role:'SELLER'};
const adminUser={id:'admin-1',role:'ADMIN'};

test('seller finance and payout mutation plus admin payout routes have role guards',()=>{
  const h=setup();
  assert.deepEqual(find(h,'GET','/api/v1/seller/finance').roles,['SELLER']);
  assert.deepEqual(find(h,'POST','/api/v1/seller/payouts').roles,['SELLER']);
  assert.deepEqual(find(h,'GET','/api/v1/admin/payouts').roles,['ADMIN']);
  assert.deepEqual(find(h,'POST','/api/v1/admin/payouts/:id/decision').roles,['ADMIN']);
});

test('seller finance returns BDT ledger, payout history and available balance',async()=>{
  const h=setup();
  const result=await find(h,'GET','/api/v1/seller/finance').handler({user:sellerUser});
  assert.equal(result.body.data.available_balance_bdt,900);
  assert.equal(result.body.data.total_sales_bdt,200);
  assert.equal(result.body.data.settlements[0].amount_bdt,100);
  assert.equal(result.body.data.payouts[0].amount_bdt,50);
});

test('approved seller can request payout within available balance and is audited',async()=>{
  const h=setup();
  const result=await find(h,'POST','/api/v1/seller/payouts').handler({user:sellerUser,body:{amount_bdt:250,method:'BKASH',account:'01700000000'}});
  assert.equal(result.status,201);
  assert.equal(result.body.data.amount_bdt,250);
  assert.equal(result.body.data.status,'REQUESTED');
  assert.ok(h.calls.some(x=>x.sql?.includes('INSERT INTO payouts')));
  assert.ok(h.calls.some(x=>x.sql?.includes('INSERT INTO audit_logs')));
  assert.ok(h.calls.some(x=>x.sql?.includes('INSERT INTO notifications')));
});

test('payout request rejects unapproved sellers and insufficient balance',async()=>{
  const pending=setup({seller:{status:'PENDING',account_status:'ACTIVE'}});
  await assert.rejects(find(pending,'POST','/api/v1/seller/payouts').handler({user:sellerUser,body:{amount_bdt:10,method:'NAGAD',account:'01700000000'}}),e=>e.status===403);
  const insufficient=setup({earned:10000,reserved:9000});
  await assert.rejects(find(insufficient,'POST','/api/v1/seller/payouts').handler({user:sellerUser,body:{amount_bdt:20,method:'NAGAD',account:'01700000000'}}),e=>e.status===409);
});

test('payout request validates method and amount',async()=>{
  const h=setup();
  await assert.rejects(find(h,'POST','/api/v1/seller/payouts').handler({user:sellerUser,body:{amount_bdt:10,method:'PAYPAL',account:'abc'}}),e=>e.status===400);
  await assert.rejects(find(h,'POST','/api/v1/seller/payouts').handler({user:sellerUser,body:{amount_bdt:-1,method:'BKASH',account:'abc'}}),e=>e.status===400);
  await assert.rejects(find(h,'POST','/api/v1/seller/payouts').handler({user:sellerUser,body:{amount_bdt:10.001,method:'BKASH',account:'abc'}}),e=>e.status===400);
});

test('admin can list requested payouts with seller context',async()=>{
  const h=setup();
  const result=await find(h,'GET','/api/v1/admin/payouts').handler({url:new URL('https://haat.test/api/v1/admin/payouts?status=REQUESTED&limit=999')});
  assert.equal(result.body.data[0].amount_bdt,50);
  assert.ok(h.calls.some(x=>x.args?.includes(300)));
});

test('admin payout decision is atomic, audited and not repeatable',async()=>{
  const h=setup();
  const result=await find(h,'POST','/api/v1/admin/payouts/:id/decision').handler({user:adminUser,params:['pay-1'],body:{decision:'APPROVE',note:'Verified'}});
  assert.equal(result.body.data.status,'APPROVED');
  assert.ok(h.calls.some(x=>x.sql?.includes('UPDATE payouts SET status=?')));
  assert.ok(h.calls.some(x=>x.sql?.includes('INSERT INTO audit_logs')));
  assert.ok(h.calls.some(x=>x.sql?.includes('INSERT INTO notifications')));
  const closed=setup({payout:{...{id:'pay-1',seller_id:'seller-1',amount_paisa:5000},status:'APPROVED'}});
  await assert.rejects(find(closed,'POST','/api/v1/admin/payouts/:id/decision').handler({user:adminUser,params:['pay-1'],body:{decision:'REJECT'}}),e=>e.status===409);
});
test('admin payout approval rechecks all reserved payouts against current seller earnings',async()=>{
  const h=setup({earned:10000,reserved:12000});
  await assert.rejects(
    find(h,'POST','/api/v1/admin/payouts/:id/decision').handler({user:adminUser,params:['pay-1'],body:{decision:'APPROVE'}}),
    error=>error.status===409
  );
  assert.ok(h.calls.some(x=>x.sql?.includes('FROM seller_profiles WHERE user_id=? FOR UPDATE')),
    'admin approval must lock the same seller profile row as payout requests');
  assert.ok(h.calls.some(x=>x.sql?.includes("status IN ('REQUESTED','APPROVED')")),
    'approval must include every pending and approved reservation');
  assert.ok(!h.calls.some(x=>x.sql?.includes('UPDATE payouts SET status=?')),
    'an over-reserved seller payout must not be approved');
});
