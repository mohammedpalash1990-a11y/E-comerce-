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

test('admin dashboard is restricted to ADMIN role',()=>{
  const h=setup();
  const route=h.routes.find(x=>x.method==='GET'&&x.path==='/api/v1/admin/dashboard');
  assert.deepEqual(route.roles,['ADMIN']);
});

test('admin dashboard returns revenue, operational counts and payout totals in BDT',async()=>{
  const h=setup();
  const route=h.routes[0];
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
  const result=await h.routes[0].handler({user:admin});
  assert.ok(Object.values(result.body.data).every(value=>value===0));
});
