import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresSellerWorkspaceRoutes } from '../apps/api/src/postgres-seller-workspace-routes.mjs';

function setup({ ownedOrder = true } = {}) {
  const routes = [], calls = [];
  const database = { q(sql) {
    return {
      async get(...args) {
        calls.push({ method: 'get', sql, args });
        if (sql.includes('FROM seller_profiles sp JOIN users')) return { id: 'seller-1', name: 'Seller', phone: '01711111111', shop_name: 'Tea Shop', shop_address: 'Dhaka', business_info: '', status: 'APPROVED', commission_bps: 800, created_at: '2026-01-01' };
        if (sql.includes('FROM seller_orders so JOIN orders')) return ownedOrder ? { id: 'so-1', order_id: 'order-1', status: 'CONFIRMED', subtotal_paisa: 20000, commission_paisa: 1600, net_paisa: 18400, payment_method: 'COD', payment_status: 'PENDING', delivery_name: 'Buyer', delivery_phone: '01700000000', delivery_address: 'Dhaka', delivery_area: 'Dhaka', customer_note: '', created_at: '2026-11-03' } : undefined;
        if (sql.includes('FROM products WHERE seller_id')) return { total: 3, pending: 1, approved: 2, rejected: 0 };
        if (sql.includes('FROM seller_orders WHERE seller_id=? AND status<>')) return { total: 4, confirmed: 1, processing: 1, shipped: 1, delivered: 1, cancelled: 0 };
        if (sql.includes('AS earned')) return { earned: 10000, commission: 800, sales: 12000, reserved: 2000, paid: 1000, pending: 3000 };
        return undefined;
      },
      async all(...args) {
        calls.push({ method: 'all', sql, args });
        if (sql.includes('FROM seller_orders WHERE seller_id=?')) return [{ id: 'so-1', order_id: 'order-1', status: 'CONFIRMED', subtotal_paisa: 20000, commission_paisa: 1600, net_paisa: 18400, created_at: '2026-11-03' }];
        if (sql.includes('FROM order_items WHERE seller_order_id')) return [{ product_id: 'p-1', product_name_bn: 'চা', quantity: 2, unit_price_paisa: 10000, variant: '' }];
        return [];
      }
    };
  }};
  registerPostgresSellerWorkspaceRoutes((method,path,roles,handler)=>routes.push({method,path,roles,handler}),
    (data,status=200)=>({status,body:{data}}),{database});
  return {routes,calls};
}
const find=(h,method,path)=>h.routes.find(x=>x.method===method&&x.path===path);
const user={id:'seller-1',role:'SELLER'};

test('seller profile and dashboard endpoints are role-scoped',()=>{
  const h=setup();
  assert.deepEqual(find(h,'GET','/api/v1/seller/profile').roles,['SELLER']);
  assert.deepEqual(find(h,'GET','/api/v1/seller/dashboard').roles,['SELLER']);
  assert.deepEqual(find(h,'GET','/api/v1/seller/orders/:id').roles,['SELLER']);
});

test('seller profile returns public shop data without KYC documents',async()=>{
  const h=setup();
  const result=await find(h,'GET','/api/v1/seller/profile').handler({user});
  assert.equal(result.body.data.shop_name,'Tea Shop');
  assert.equal(result.body.data.commission_percent,8);
  assert.equal('kyc_nid' in result.body.data,false);
});

test('seller dashboard returns product, order and ledger summaries',async()=>{
  const h=setup();
  const result=await find(h,'GET','/api/v1/seller/dashboard').handler({user});
  assert.equal(result.body.data.products.pending,1);
  assert.equal(result.body.data.orders.delivered,1);
  assert.equal(result.body.data.finance.available_balance_bdt,80);
  assert.equal(result.body.data.finance.pending_balance_bdt,30);
  assert.equal(result.body.data.recent_orders[0].orderNumber,'HAAT-ORDER1');
});

test('seller order detail is ownership-scoped and includes only that seller sub-order items',async()=>{
  const h=setup();
  const result=await find(h,'GET','/api/v1/seller/orders/:id').handler({user,params:['so-1']});
  assert.equal(result.body.data.delivery.phone,'01700000000');
  assert.equal(result.body.data.items.length,1);
  assert.equal(result.body.data.items[0].unit_price_bdt,100);
  assert.ok(h.calls.some(x=>x.sql.includes('WHERE so.id=? AND so.seller_id=?')));
});

test('seller cannot read another seller order',async()=>{
  const h=setup({ownedOrder:false});
  await assert.rejects(find(h,'GET','/api/v1/seller/orders/:id').handler({user,params:['foreign-order']}),e=>e.status===404);
});
