import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresAdminDashboardRoutes } from '../apps/api/src/postgres-admin-dashboard-routes.mjs';

function setup(row = {
  total_revenue_paisa: '1250000', total_orders: '48', total_customers: '31',
  total_sellers: '8', pending_seller_applications: '2', pending_product_approvals: '4',
  total_products: '90', active_products: '76', cancelled_orders: '3',
  pending_payouts: '2', pending_payout_amount_paisa: '500000',
  platform_commission_paisa: '87500'
}) {
  const routes = [], calls = [];
  const database = { q(sql) { return { async get(...args) { calls.push({sql,args}); return row; } }; } };
  registerPostgresAdminDashboardRoutes((method,path,roles,handler)=>routes.push({method,path,roles,handler}),
    (data,status=200)=>({status,body:{data}}),{database});
  return {routes,calls};
}
const admin={id:'admin-1',role:'ADMIN'};
const reportUrl = (query='from=2026-11-01&to=2026-11-06') => new URL('https://api.example.test/api/v1/admin/reports/summary?' + query);
const reportRow = {
  orders_count:'12',paid_orders_count:'8',cancelled_orders_count:'2',unpaid_cod_orders_count:'1',
  gross_merchandise_paisa:'125000',discounts_paisa:'5000',shipping_paisa:'8000',
  platform_commission_paisa:'9600',seller_earnings_paisa:'110400',seller_reversals_paisa:'500',
  requested_refund_count:'2',requested_refund_paisa:'3000',
  requested_payout_count:'1',requested_payout_paisa:'2000',
  approved_payout_count:'2',approved_payout_paisa:'9000',
  rejected_payout_count:'1',rejected_payout_paisa:'1000'
};

test('admin dashboard is restricted to ADMIN role',()=>{
  const h=setup();
  const route=h.routes.find(x=>x.method==='GET'&&x.path==='/api/v1/admin/dashboard');
  assert.deepEqual(route.roles,['ADMIN']);
});

test('admin dashboard returns revenue, operational counts and payout totals in BDT',async()=>{
  const h=setup();
  const route=h.routes.find(x=>x.path==='/api/v1/admin/dashboard');
  const result=await route.handler({user:admin});
  assert.deepEqual(result.body.data,{
    total_revenue_bdt:12500,total_orders:48,total_customers:31,total_sellers:8,
    pending_seller_applications:2,pending_product_approvals:4,total_products:90,
    active_products:76,cancelled_orders:3,pending_payouts:2,
    pending_payout_amount_bdt:5000,platform_commission_bdt:875
  });
  assert.match(h.calls[0].sql,/payment_status='PAID' AND status<>'CANCELLED'/);
  assert.match(h.calls[0].sql,/status='PENDING_REVIEW'/);
  assert.match(h.calls[0].sql,/kind='COMMISSION'/);
});

test('admin dashboard handles empty aggregates without NaN',async()=>{
  const h=setup({total_revenue_paisa:null,total_orders:null,total_customers:null,total_sellers:null,
    pending_seller_applications:null,pending_product_approvals:null,total_products:null,
    active_products:null,cancelled_orders:null,pending_payouts:null,pending_payout_amount_paisa:null,
    platform_commission_paisa:null});
  const route=h.routes.find(x=>x.path==='/api/v1/admin/dashboard');
  const result=await route.handler({user:admin});
  assert.ok(Object.values(result.body.data).every(value=>value===0));
});

test('financial report summary is restricted to ADMIN and documents its Dhaka date dimensions',async()=>{
  const h=setup(reportRow);
  const route=h.routes.find(x=>x.path==='/api/v1/admin/reports/summary');
  assert.deepEqual(route.roles,['ADMIN']);
  const result=await route.handler({url:reportUrl()});
  assert.deepEqual(result.body.data.period,{from:'2026-11-01',to:'2026-11-06',time_zone:'Asia/Dhaka',seller_id:null});
  assert.deepEqual(result.body.data.date_basis,{
    orders:'orders.created_at',financial_ledger:'transactions.created_at',
    refunds:'refunds.created_at',payouts:'payouts.created_at'
  });
  assert.deepEqual(result.body.data.orders,{total:12,paid:8,cancelled:2,unpaid_cod:1});
  assert.deepEqual(result.body.data.sales,{
    gross_merchandise:{paisa:125000,bdt:1250},
    discounts:{paisa:5000,bdt:50},
    net_merchandise:{paisa:120000,bdt:1200},
    shipping:{paisa:8000,bdt:80}
  });
  assert.deepEqual(result.body.data.finance,{
    platform_commission:{paisa:9600,bdt:96},
    seller_earnings:{paisa:110400,bdt:1104},
    seller_reversals:{paisa:500,bdt:5}
  });
  assert.deepEqual(result.body.data.refunds,{
    requested_count:2,requested_amount:{paisa:3000,bdt:30}
  });
  assert.deepEqual(result.body.data.payouts,{
    requested_count:1,requested_amount:{paisa:2000,bdt:20},
    approved_count:2,approved_amount:{paisa:9000,bdt:90},
    rejected_count:1,rejected_amount:{paisa:1000,bdt:10}
  });
});

test('seller-scoped financial report uses bound parameters and does not attribute parent shipping to one seller',async()=>{
  const h=setup(reportRow);
  const route=h.routes.find(x=>x.path==='/api/v1/admin/reports/summary');
  const result=await route.handler({url:reportUrl('from=2026-11-06&to=2026-11-06&seller_id=seller-1')});
  assert.equal(h.calls.length,1);
  assert.deepEqual(h.calls[0].args,['seller-1','2026-11-06','2026-11-06']);
  assert.equal(result.body.data.period.seller_id,'seller-1');
  assert.equal(result.body.data.sales.shipping,null);
  assert.equal(result.body.data.refunds,null,'parent-order refunds are not attributed to an individual seller');
  assert.match(h.calls[0].sql,/so\.coupon_discount_paisa/);
  assert.match(h.calls[0].sql,/t\.seller_id=rp\.seller_id/);
  assert.match(h.calls[0].sql,/p\.seller_id=rp\.seller_id/);
});

test('financial report rejects invalid dates, reversed ranges, oversized ranges and invalid seller ids before querying',async()=>{
  const h=setup(reportRow);
  const route=h.routes.find(x=>x.path==='/api/v1/admin/reports/summary');
  await assert.rejects(route.handler({url:reportUrl('from=2026-02-30&to=2026-03-01')}),error=>error.status===400);
  await assert.rejects(route.handler({url:reportUrl('from=2026-11-07&to=2026-11-06')}),error=>error.status===400);
  await assert.rejects(route.handler({url:reportUrl('from=2025-01-01&to=2026-11-06')}),error=>error.status===400);
  await assert.rejects(route.handler({url:reportUrl('from=2026-11-01&to=2026-11-06&seller_id=bad%2Fid')}),error=>error.status===400);
  assert.equal(h.calls.length,0);
});

test('financial report rejects aggregate BIGINT values outside JavaScript safe integer range',async()=>{
  const h=setup({...reportRow,gross_merchandise_paisa:'9007199254740992'});
  const route=h.routes.find(x=>x.path==='/api/v1/admin/reports/summary');
  await assert.rejects(route.handler({url:reportUrl()}),error=>error.status===503);
});
