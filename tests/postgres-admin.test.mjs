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
    if(sql.includes('FROM payouts WHERE id='))return{id:'pay-1',seller_id:'seller-1',amount_paisa:'25000',status:'REQUESTED'};
    if(sql.includes('FROM seller_profiles'))return{user_id:'seller-1'};
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
    if(sql.includes('FROM payouts WHERE id='))return{id:'pay-2',seller_id:'seller-1',amount_paisa:'90000',status:'REQUESTED'};
    if(sql.includes('FROM seller_profiles'))return{user_id:'seller-1'};
    if(sql.includes(' reserved FROM payouts'))return{reserved:'20000'};
    if(sql.includes(' earned FROM transactions'))return{earned:'100000'};
    return undefined;
  });
  const repo=createPostgresAdminRepository(db);
  await assert.rejects(repo.decidePayout({payoutId:'pay-2',actorId:'admin-1',decision:'APPROVE'}),e=>e.status===409&&e.code==='INSUFFICIENT_BALANCE');
  assert.equal(db.calls.some(x=>x.sql?.includes("UPDATE payouts SET status='APPROVED'")),false);
});

test('payout decision is single-use and rejects an already decided request',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM payouts WHERE id=')?{id:'pay-3',seller_id:'seller-1',amount_paisa:'1000',status:'APPROVED'}:sql.includes('FROM seller_profiles')?{user_id:'seller-1'}:undefined);
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
  const db=fakeDatabase((method,sql)=>sql.includes('COALESCE((SELECT SUM(total_paisa)')?{gross:'100000',refunds:'5000',commission:'8000',seller_earnings:'70000',paid_out:'10000',pending_payouts:'5000',seller_pending:'20000'}:undefined);
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

test('seller approval locks profile, activates user and records audit notification',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM seller_profiles WHERE user_id=')?{user_id:'seller-7',status:'PENDING'}:undefined);
  const repo=createPostgresAdminRepository(db,{createId:()=> 'evt-1',clock:()=> '2026-11-02T10:00:00.000Z'});
  assert.deepEqual(await repo.decideSeller({sellerId:'seller-7',actorId:'admin-1',decision:'APPROVE',reason:'KYC verified'}),{id:'seller-7',status:'APPROVED'});
  assert.ok(db.calls.some(x=>x.sql?.includes('FROM seller_profiles WHERE user_id=')&&x.sql.includes('FOR UPDATE')));
  assert.ok(db.calls.some(x=>x.sql?.includes('UPDATE users SET status=')&&x.values[0]==='ACTIVE'));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO audit_logs')&&x.values[2]==='SELLER_APPROVED'));
});

test('seller suspension revokes existing sessions in the same transaction',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM seller_profiles WHERE user_id=')?{user_id:'seller-8',status:'APPROVED'}:undefined);
  const repo=createPostgresAdminRepository(db);
  await repo.decideSeller({sellerId:'seller-8',actorId:'admin-1',decision:'SUSPEND'});
  assert.ok(db.calls.some(x=>x.sql?.includes('DELETE FROM sessions WHERE user_id=')&&x.values[0]==='seller-8'));
  assert.ok(db.calls.some(x=>x.sql?.includes("UPDATE users SET status=")&&x.values[0]==='SUSPENDED'));
});

test('commission update is bounded to 0 through 5000 basis points',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM seller_profiles WHERE user_id=')?{user_id:'seller-9'}:undefined);
  const repo=createPostgresAdminRepository(db);
  assert.deepEqual(await repo.setCommission({sellerId:'seller-9',actorId:'admin-1',commissionBps:1250}),{id:'seller-9',commission_bps:1250});
  await assert.rejects(repo.setCommission({sellerId:'seller-9',actorId:'admin-1',commissionBps:5001}),e=>e.status===400&&e.code==='INVALID_COMMISSION');
});

test('product moderation cannot activate product while seller is not approved',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM products WHERE id=')?{id:'product-1',seller_id:'seller-1',status:'PENDING_REVIEW'}:sql.includes('FROM seller_profiles WHERE user_id=')?{status:'PENDING'}:undefined);
  const repo=createPostgresAdminRepository(db);
  await assert.rejects(repo.moderateProduct({productId:'product-1',actorId:'admin-1',decision:'APPROVE'}),e=>e.status===409&&e.code==='SELLER_NOT_APPROVED');
  assert.equal(db.calls.some(x=>x.sql?.includes('UPDATE products SET status=')),false);
});

test('product moderation records approved state, audit and seller notification',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM products WHERE id=')?{id:'product-2',seller_id:'seller-2',status:'PENDING_REVIEW'}:sql.includes('FROM seller_profiles WHERE user_id=')?{status:'APPROVED'}:undefined);
  const repo=createPostgresAdminRepository(db,{createId:()=> 'evt-2'});
  assert.deepEqual(await repo.moderateProduct({productId:'product-2',actorId:'admin-1',decision:'APPROVE'}),{id:'product-2',status:'ACTIVE'});
  assert.ok(db.calls.some(x=>x.sql?.includes('UPDATE products SET status=')&&x.values[0]==='ACTIVE'));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO audit_logs')&&x.values[2]==='PRODUCT_ACTIVE'));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO notifications')&&x.values[1]==='seller-2'));
});

test('product moderation only allows the declared source state',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM products WHERE id=')?{id:'product-3',seller_id:'seller-3',status:'ACTIVE'}:undefined);
  const repo=createPostgresAdminRepository(db);
  await assert.rejects(repo.moderateProduct({productId:'product-3',actorId:'admin-1',decision:'APPROVE'}),e=>e.status===409&&e.code==='PRODUCT_NOT_MODERATABLE');
});

test('full refund is atomic, updates payment state and writes negative finance ledger entries',async()=>{
  const db=fakeDatabase((method,sql)=>{
    if(sql.includes('FROM orders WHERE id='))return{id:'order-1',user_id:'buyer-1',total_paisa:'100000',payment_status:'PAID'};
    if(sql.includes('FROM refunds WHERE order_id='))return{amount:'0'};
    if(sql.includes('FROM seller_orders WHERE order_id='))return[{id:'so-1',seller_id:'seller-1',net_paisa:'80000'}];
    return undefined;
  });
  const repo=createPostgresAdminRepository(db,{createId:(()=>{let n=0;return()=> 'refund-'+(++n);})(),clock:()=> '2026-11-02T10:00:00.000Z'});
  assert.deepEqual(await repo.createRefund({orderId:'order-1',actorId:'admin-1',amountBdt:1000,reason:'customer issue'}),{id:'refund-1',status:'APPROVED'});
  assert.ok(db.calls.some(x=>x.sql?.includes("UPDATE orders SET payment_status=")&&x.values[0]==='REFUNDED'));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO transactions')&&x.values[1]==='REFUND'&&x.values[5]===-100000));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO transactions')&&x.values[1]==='SELLER_REVERSAL'&&x.values[5]===-80000));
  assert.ok(db.calls.some(x=>x.sql?.includes("UPDATE payments SET status='REFUNDED'")));
});

test('refund amount cannot exceed the remaining order total',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM orders WHERE id=')?{id:'order-2',user_id:'buyer-2',total_paisa:'10000',payment_status:'PAID'}:sql.includes('FROM refunds WHERE order_id=')?{amount:'5000'}:undefined);
  const repo=createPostgresAdminRepository(db);
  await assert.rejects(repo.createRefund({orderId:'order-2',actorId:'admin-1',amountBdt:60}),e=>e.status===409&&e.code==='REFUND_LIMIT_EXCEEDED');
  assert.equal(db.calls.some(x=>x.sql?.includes('INSERT INTO transactions')),false);
});

test('requested refund approval serializes on parent order and applies seller earning reversal',async()=>{
  const db=fakeDatabase((method,sql)=>{
    if(sql.includes('FROM refunds WHERE id=')&&!sql.includes('FOR UPDATE'))return{order_id:'order-3'};
    if(sql.includes('FROM orders WHERE id='))return{id:'order-3',user_id:'buyer-3',total_paisa:'20000',payment_status:'PAID'};
    if(sql.includes('FROM refunds WHERE id=')&&sql.includes('FOR UPDATE'))return{id:'refund-3',order_id:'order-3',amount_paisa:'5000',status:'REQUESTED'};
    if(sql.includes('FROM refunds WHERE order_id='))return{amount:'0'};
    if(sql.includes('FROM seller_orders WHERE order_id='))return[{id:'so-3',seller_id:'seller-3',net_paisa:'10000'}];
    return undefined;
  });
  const repo=createPostgresAdminRepository(db);
  assert.deepEqual(await repo.approveRefund({refundId:'refund-3',actorId:'admin-1'}),{id:'refund-3',status:'APPROVED'});
  assert.ok(db.calls.some(x=>x.sql?.includes('FROM orders WHERE id=')&&x.sql.includes('FOR UPDATE')));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO transactions')&&x.values[1]==='SELLER_REVERSAL'&&x.values[5]===-2500));
});

test('refund rejection is single-use and does not change order payment state',async()=>{
  const db=fakeDatabase((method,sql)=>{
    if(sql.includes('FROM refunds WHERE id=')&&!sql.includes('FOR UPDATE'))return{order_id:'order-4'};
    if(sql.includes('FROM orders WHERE id='))return{id:'order-4'};
    if(sql.includes('FROM refunds WHERE id=')&&sql.includes('FOR UPDATE'))return{id:'refund-4',status:'REQUESTED'};
    return undefined;
  });
  const repo=createPostgresAdminRepository(db);
  assert.deepEqual(await repo.rejectRefund({refundId:'refund-4',actorId:'admin-1'}),{id:'refund-4',status:'REJECTED'});
  assert.ok(db.calls.some(x=>x.sql?.includes("UPDATE refunds SET status='REJECTED'")));
  assert.equal(db.calls.some(x=>x.sql?.includes('INSERT INTO transactions')),false);
});

test('admin seller overview scopes all finance aggregates to the selected seller',async()=>{
  const db=fakeDatabase((method,sql)=>{
    if(sql.includes('FROM seller_profiles sp JOIN users u WHERE u.id='))return{id:'seller-10',status:'APPROVED',shop_name:'Shop 10'};
    if(sql.includes('product_count'))return{product_count:'4',order_count:'3',earnings:'50000',commission:'5000',paid:'10000',reserved:'15000',pending:'20000'};
    return undefined;
  });
  const repo=createPostgresAdminRepository(db);
  const result=await repo.getSellerOverview('seller-10');
  assert.equal(result.product_count,4);
  assert.equal(result.order_count,3);
  assert.equal(result.finance.available_bdt,350);
  assert.deepEqual(db.calls[1].values,Array(7).fill('seller-10'));
});

test('admin product listing validates status and formats paisa without losing decimals',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM products p JOIN categories')?[{id:'p-1',name_bn:'পণ্য',price_paisa:'12550',discount_paisa:'9999',stock:'2',status:'ACTIVE'}]:[]);
  const repo=createPostgresAdminRepository(db);
  const rows=await repo.listProducts({status:'ACTIVE',query:'পণ্য'});
  assert.equal(rows[0].price_bdt,125.5);
  assert.equal(rows[0].discount_price_bdt,99.99);
  assert.deepEqual(db.calls[0].values,['%পণ্য%','%পণ্য%','ACTIVE',100]);
});

test('seller list rejects unknown moderation states',async()=>{
  const repo=createPostgresAdminRepository(fakeDatabase(()=>[]));
  await assert.rejects(repo.listSellers({status:'UNKNOWN'}),e=>e.status===400&&e.code==='INVALID_SELLER_STATUS');
});
