import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresAdminRepository } from '../apps/api/src/postgres-admin.mjs';

function fakeDatabase(handler) {
  const calls=[];
  return {
    calls,
    q(sql) {
      return {
        async get(...values) { calls.push({method:'get',sql,values}); return handler('get',sql,values,calls); },
        async all(...values) { calls.push({method:'all',sql,values}); return handler('all',sql,values,calls) || []; },
        async run(...values) { calls.push({method:'run',sql,values}); return handler('run',sql,values,calls) || {changes:1}; }
      };
    },
    async tx(callback) { calls.push({method:'tx'}); return callback(); }
  };
}

test('admin repository requires a PostgreSQL-compatible database adapter',()=>{
  assert.throws(()=>createPostgresAdminRepository({q(){}}),/q\(\) and tx\(\)/);
});

test('payout list validates status and returns integer-paisa amount as BDT',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM payouts p LEFT JOIN')?[{id:'pay-1',seller_id:'seller-1',amount_paisa:'12550',status:'REQUESTED',shop_name:'Shop'}]:[]);
  const repo=createPostgresAdminRepository(db);
  const rows=await repo.listPayouts({status:'REQUESTED'});
  assert.equal(rows[0].amount_bdt,125.5);
  assert.deepEqual(db.calls[0].values,['REQUESTED',200]);
  await assert.rejects(repo.listPayouts({status:'UNKNOWN'}),e=>e.status===400&&e.code==='INVALID_PAYOUT_STATUS');
});

test('payout approval locks pending request, verifies available earnings, posts ledger transaction and audit',async()=>{
  const db=fakeDatabase((method,sql)=>{
    if(sql.includes('FROM payouts WHERE id='))return{id:'pay-1',seller_id:'seller-1',amount_paisa:'25000',status:'REQUESTED'};\n    if(sql.includes('FROM seller_profiles'))return{user_id:'seller-1'};
    if(sql.includes(' reserved FROM payouts'))return{reserved:'10000'};
    if(sql.includes(' earned FROM transactions'))return{earned:'100000'};
    return undefined;
  });
  const repo=createPostgresAdminRepository(db,{createId:(()=>{let i=0;return()=> 'id-'+(++i);})(),clock:()=> '2026-11-02T10:00:00.000Z'});
  const result=await repo.decidePayout({payoutId:'pay-1',actorId:'admin-1',decision:'APPROVE',note:'verified'});
  assert.deepEqual(result,{id:'pay-1',status:'APPROVED'});
  assert.ok(db.calls.some(x=>x.sql?.includes('FOR UPDATE')&&x.values[0]==='pay-1'));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO transactions')&&x.values[1]==='PAYOUT'&&x.values[5]===-25000));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO audit_logs')&&x.values[2]==='PAYOUT_APPROVED'));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO notifications')&&x.values[1]==='seller-1'));
});

test('payout approval rejects when seller earnings are already reserved',async()=>{
  const db=fakeDatabase((method,sql)=>{
    if(sql.includes('FROM payouts WHERE id='))return{id:'pay-2',seller_id:'seller-1',amount_paisa:'90000',status:'REQUESTED'};\n    if(sql.includes('FROM seller_profiles'))return{user_id:'seller-1'};
    if(sql.includes(' reserved FROM payouts'))return{reserved:'20000'};
    if(sql.includes(' earned FROM transactions'))return{earned:'100000'};
    return undefined;
  });
  const repo=createPostgresAdminRepository(db);
  await assert.rejects(repo.decidePayout({payoutId:'pay-2',actorId:'admin-1',decision:'APPROVE'}),e=>e.status===409&&e.code==='INSUFFICIENT_BALANCE');
  assert.equal(db.calls.some(x=>x.sql?.includes("UPDATE payouts SET status='APPROVED'")),false);
});

test('payout decision is single-use and rejects an already decided request',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM payouts WHERE id=')?{id:'pay-3',seller_id:'seller-1',amount_paisa:'1000',status:'APPROVED'}:undefined);
  const repo=createPostgresAdminRepository(db);
  await assert.rejects(repo.decidePayout({payoutId:'pay-3',actorId:'admin-1',decision:'REJECT'}),e=>e.status===409&&e.code==='PAYOUT_NOT_PENDING');
  assert.equal(db.calls.some(x=>x.sql?.includes('INSERT INTO transactions')),false);
});

test('payout rejection releases the reservation and records audit without a payout transaction',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM payouts WHERE id=')?{id:'pay-4',seller_id:'seller-2',amount_paisa:'5000',status:'REQUESTED'}:sql.includes('FROM seller_profiles')?{user_id:'seller-2'}:undefined);
  const repo=createPostgresAdminRepository(db,{createId:()=> 'event-1'});
  assert.deepEqual(await repo.decidePayout({payoutId:'pay-4',actorId:'admin-1',decision:'REJECT',note:'invalid account'}),{id:'pay-4',status:'REJECTED'});
  assert.ok(db.calls.some(x=>x.sql?.includes("UPDATE payouts SET status='REJECTED'")));
  assert.equal(db.calls.some(x=>x.sql?.includes('INSERT INTO transactions')),false);
});

test('finance summary uses approved revenue and computes seller available balance',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('SELECT\n      COALESCE')?{gross:'100000',refunds:'5000',commission:'8000',seller_earnings:'70000',paid_out:'10000',pending_payouts:'5000',seller_pending:'20000'}:undefined);
  const repo=createPostgresAdminRepository(db);
  const summary=await repo.financeSummary();
  assert.equal(summary.gross_sales_bdt,1000);
  assert.equal(summary.net_sales_bdt,950);
  assert.equal(summary.platform_commission_bdt,80);
  assert.equal(summary.seller_available_balance_bdt,550);
  assert.equal(summary.seller_pending_balance_bdt,200);
});

test('finance report rejects malformed and reversed date ranges',async()=>{
  const repo=createPostgresAdminRepository(fakeDatabase(()=>[]));
  await assert.rejects(repo.financeReport({from:'not-a-date'}),e=>e.status===400&&e.code==='INVALID_DATE_RANGE');
  await assert.rejects(repo.financeReport({from:'2026-12-01',to:'2026-11-01'}),e=>e.status===400&&e.code==='INVALID_DATE_RANGE');
});
