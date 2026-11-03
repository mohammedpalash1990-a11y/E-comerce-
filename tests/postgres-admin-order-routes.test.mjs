import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPostgresAdminOrderRoutes } from '../apps/api/src/postgres-admin-order-routes.mjs';

function setup({ order = { id:'order-1',user_id:'customer-1',total_paisa:11000,subtotal_paisa:10000,shipping_paisa:1000,discount_paisa:0,status:'CONFIRMED',payment_status:'PENDING',payment_method:'COD',customer_name:'Buyer',customer_phone:'01700000000',delivery_name:'Buyer',delivery_phone:'01700000000',delivery_address:'Dhaka',delivery_area:'Dhaka',admin_note:'' } } = {}) {
  const routes=[],calls=[];
  const database={
    q(sql){return{
      async get(...args){calls.push({method:'get',sql,args});if(sql.includes('FROM orders o LEFT JOIN users'))return order;if(sql.includes('FROM orders WHERE id=? FOR UPDATE'))return order;if(sql.includes('FROM orders WHERE id=? FOR UPDATE'))return order;return undefined;},
      async all(...args){calls.push({method:'all',sql,args});
        if(sql.includes('FROM order_items WHERE order_id'))return [{id:'item-1',product_id:'p-1',product_name_bn:'চা',quantity:2,unit_price_paisa:5000}];
        if(sql.includes('FROM seller_orders so LEFT JOIN seller_profiles'))return [{id:'so-1',seller_id:'seller-1',status:'CONFIRMED',subtotal_paisa:10000,commission_paisa:800,net_paisa:9200,shop_name:'Tea Shop'}];
        if(sql.includes('FROM order_events'))return [{status:'CONFIRMED',note:'created',created_at:'2026-11-03'}];
        if(sql.includes('FROM payments'))return [{id:'pay-1',method:'COD',amount_paisa:11000,status:'PENDING'}];
        return[];
      },
      async run(...args){calls.push({method:'run',sql,args});return{changes:1,rows:[]};}
    };},
    async tx(fn){calls.push({method:'tx'});return fn();}
  };
  registerPostgresAdminOrderRoutes((method,path,roles,handler)=>routes.push({method,path,roles,handler}),
    (data,status=200)=>({status,body:{data}}),{database,id:()=> 'audit-id',now:()=> '2026-11-03T00:00:00.000Z'});
  return{routes,calls};
}
const find=(h,method,path)=>h.routes.find(x=>x.method===method&&x.path===path);
const admin={id:'admin-1',role:'ADMIN'};

test('admin order detail and operations are restricted to ADMIN',()=>{
  const h=setup();
  for(const [method,path] of [['GET','/api/v1/admin/orders/:id'],['POST','/api/v1/admin/orders/:id/note'],['POST','/api/v1/admin/orders/:id/shipping']])assert.deepEqual(find(h,method,path).roles,['ADMIN']);
});

test('admin order detail includes customer, delivery, sellers, items, history and payments',async()=>{
  const h=setup();
  const result=await find(h,'GET','/api/v1/admin/orders/:id').handler({params:['order-1']});
  assert.equal(result.body.data.orderNumber,'HAAT-ORDER1');
  assert.equal(result.body.data.customer.phone,'01700000000');
  assert.equal(result.body.data.items[0].unit_price_bdt,50);
  assert.equal(result.body.data.sellers[0].commission_bdt,8);
  assert.equal(result.body.data.history[0].status,'CONFIRMED');
  assert.equal(result.body.data.payments[0].amount_bdt,110);
});

test('admin order detail returns 404 for missing order',async()=>{
  const h=setup({order:null});
  await assert.rejects(find(h,'GET','/api/v1/admin/orders/:id').handler({params:['missing']}),e=>e.status===404);
});

test('admin note is saved with an audit record inside a transaction',async()=>{
  const h=setup();
  const result=await find(h,'POST','/api/v1/admin/orders/:id/note').handler({user:admin,params:['order-1'],body:{note:'Call customer'}});
  assert.equal(result.body.data.saved,true);
  assert.ok(h.calls.some(x=>x.sql?.includes('UPDATE orders SET admin_note=?')));
  assert.ok(h.calls.some(x=>x.sql?.includes('INSERT INTO audit_logs')));
});

test('admin can update shipping before payment and payment amount follows order total',async()=>{
  const h=setup();
  const result=await find(h,'POST','/api/v1/admin/orders/:id/shipping').handler({user:admin,params:['order-1'],body:{shipping_bdt:35}});
  assert.deepEqual(result.body.data,{id:'order-1',shipping_bdt:35,total_bdt:135});
  assert.ok(h.calls.some(x=>x.sql?.includes('UPDATE payments SET amount_paisa=?')));
});

test('admin cannot change shipping after payment or for invalid amount',async()=>{
  const paid=setup({order:{id:'order-1',subtotal_paisa:10000,discount_paisa:0,shipping_paisa:0,status:'DELIVERED',payment_status:'PAID'}});
  await assert.rejects(find(paid,'POST','/api/v1/admin/orders/:id/shipping').handler({user:admin,params:['order-1'],body:{shipping_bdt:20}}),e=>e.status===409);
  const invalid=setup();
  await assert.rejects(find(invalid,'POST','/api/v1/admin/orders/:id/shipping').handler({user:admin,params:['order-1'],body:{shipping_bdt:-2}}),e=>e.status===400);
});
