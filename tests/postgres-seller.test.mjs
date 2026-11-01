import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresSellerRepository } from '../apps/api/src/postgres-seller.mjs';

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
const inventory={async setStock(input){inventory.last=input;return {stock:input.stock};}};
const sellerId='seller-1';
const validProduct={name_bn:'চা পাতা',name_en:'Tea Leaf',price_bdt:250,stock:12,category_slug:'grocery',description:'Fresh tea',images:['https://cdn.example/tea.jpg']};

test('seller repository requires the shared PostgreSQL inventory ledger',()=>{
  assert.throws(()=>createPostgresSellerRepository({q(){},tx(){} }),/inventory repository is required/);
});

test('seller product list is strictly scoped to the authenticated seller',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM products p JOIN categories')?[{id:'p1',name_bn:'চা',name_en:'Tea',price_paisa:'25000',discount_paisa:'20000',stock:'4',status:'ACTIVE',category_slug:'grocery'}]:[]);
  const repo=createPostgresSellerRepository(db,{inventoryRepository:inventory});
  const rows=await repo.listProducts(sellerId);
  assert.equal(rows[0].sale_price_bdt,200);
  const call=db.calls.find(x=>x.sql.includes('FROM products p JOIN categories'));
  assert.match(call.sql,/WHERE p\.seller_id=\?/);
  assert.deepEqual(call.values,[sellerId]);
});

test('seller cannot read another seller product by ID',async()=>{
  const db=fakeDatabase(()=>undefined);
  const repo=createPostgresSellerRepository(db,{inventoryRepository:inventory});
  assert.equal(await repo.getProduct(sellerId,'foreign-product'),null);
  assert.deepEqual(db.calls[0].values,['foreign-product',sellerId]);
  assert.match(db.calls[0].sql,/p\.seller_id=\?/);
});

test('product creation uses pending moderation and the append-only inventory ledger',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM seller_profiles')?{user_id:sellerId,status:'APPROVED'}:sql.includes('FROM categories')?{id:'category-1'}:undefined);
  let stockInput;
  const ledger={async setStock(input){stockInput=input;return {stock:input.stock};}};
  const repo=createPostgresSellerRepository(db,{inventoryRepository:ledger,createId:(()=>{let n=0;return()=> 'id-'+(++n);})(),clock:()=> '2026-11-01T00:00:00.000Z'});
  const result=await repo.createProduct(sellerId,validProduct);
  assert.equal(result.status,'PENDING_REVIEW');
  assert.equal(stockInput.stock,12);
  assert.equal(stockInput.productId,'id-1');
  assert.equal(stockInput.reason,'SELLER_PRODUCT_INITIAL_STOCK');
  assert.ok(db.calls.some(x=>x.sql?.includes("VALUES(")&&x.sql.includes("'PENDING_REVIEW'")));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO audit_logs')));
});

test('suspended seller cannot submit products',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM seller_profiles')?{user_id:sellerId,status:'SUSPENDED'}:undefined);
  const repo=createPostgresSellerRepository(db,{inventoryRepository:inventory});
  await assert.rejects(repo.createProduct(sellerId,validProduct),e=>e.status===403&&e.code==='SELLER_NOT_APPROVED');
  assert.equal(db.calls.some(x=>x.sql?.includes('INSERT INTO products')),false);
});

test('product update uses seller ownership predicate and does not bypass stock ledger',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM seller_profiles')?{user_id:sellerId,status:'APPROVED'}:sql.includes('FROM products WHERE id=')?{id:'p1',price_paisa:'25000',discount_paisa:null}:undefined);
  const repo=createPostgresSellerRepository(db,{inventoryRepository:inventory});
  await repo.updateProduct(sellerId,'p1',{name_bn:'নতুন নাম',stock:99,images:[]});
  const lock=db.calls.find(x=>x.sql?.includes('FROM products WHERE id='));
  assert.deepEqual(lock.values,['p1',sellerId]);
  assert.match(lock.sql,/seller_id=\?/);
  assert.equal(db.calls.some(x=>x.sql?.includes('UPDATE products SET stock=')),false);
  assert.equal(inventory.last.stock,99);
  assert.equal(inventory.last.reason,'SELLER_PRODUCT_STOCK_UPDATE');
  assert.ok(db.calls.some(x=>x.sql?.includes("status='PENDING_REVIEW'")));
});

test('archive operation only affects seller-owned products',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM seller_profiles')?{user_id:sellerId,status:'APPROVED'}:sql.includes('SELECT id FROM products')?{id:'p1'}:undefined);
  const repo=createPostgresSellerRepository(db,{inventoryRepository:inventory});
  assert.deepEqual(await repo.archiveProduct(sellerId,'p1'),{deleted:true});
  assert.ok(db.calls.some(x=>x.sql?.includes("UPDATE products SET status='ARCHIVED'")&&x.values[1]==='p1'&&x.values[2]===sellerId));
  assert.ok(db.calls.some(x=>x.sql?.includes('DELETE FROM cart_items')));
});

test('payout request requires approved seller, checks duplicate and available integer-paisa balance',async()=>{
  const db=fakeDatabase((method,sql)=> {
    if(sql.includes('FROM seller_profiles'))return {user_id:sellerId,status:'APPROVED'};
    if(sql.includes('SELECT id FROM payouts'))return undefined;
    if(sql.includes(' reserved FROM payouts'))return {reserved:'0'};
    if(sql.includes(' earnings FROM transactions'))return {earnings:'100000'};
    return undefined;
  });
  const repo=createPostgresSellerRepository(db,{inventoryRepository:inventory,createId:()=> 'payout-1'});
  const result=await repo.requestPayout(sellerId,{amount_bdt:500,method:'BKASH',account:'01711111111'});
  assert.deepEqual(result,{id:'payout-1',status:'REQUESTED'});
  assert.ok(db.calls.some(x=>x.sql?.includes('FOR UPDATE')&&x.sql.includes('seller_profiles')));
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO payouts')&&x.values[2]===50000));
});

test('duplicate payout request is rejected without inserting a second payout',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM seller_profiles')?{user_id:sellerId,status:'APPROVED'}:sql.includes('SELECT id FROM payouts')?{id:'existing-payout'}:undefined);
  const repo=createPostgresSellerRepository(db,{inventoryRepository:inventory});
  await assert.rejects(repo.requestPayout(sellerId,{amount_bdt:500,method:'BKASH',account:'01711111111'}),e=>e.status===409&&e.code==='DUPLICATE_PAYOUT');
  assert.equal(db.calls.some(x=>x.sql?.includes('INSERT INTO payouts')),false);
});

test('courier booking locks and scopes the seller order before creating a shipment',async()=>{
  const db=fakeDatabase((method,sql)=>{if(sql.includes('FROM seller_profiles'))return{user_id:sellerId,status:'APPROVED'};if(sql.includes('FROM seller_orders so JOIN orders'))return{id:'so-1',order_id:'o-1',status:'PROCESSING',delivery_area:'Dhaka'};return undefined;});
  const repo=createPostgresSellerRepository(db,{inventoryRepository:inventory,ordersRepository:{async transitionSellerOrder(){}} ,createId:(()=>{let n=0;return()=> 'ship-'+(++n);})()});
  const result=await repo.bookSellerShipment(sellerId,'so-1','PATHAO');
  assert.equal(result.status,'BOOKED');
  assert.equal(result.provider,'PATHAO');
  const orderRead=db.calls.find(x=>x.sql?.includes('FROM seller_orders so JOIN orders'));
  assert.deepEqual(orderRead.values,['so-1',sellerId]);
  assert.ok(db.calls.some(x=>x.sql?.includes('INSERT INTO shipments')));
  assert.ok(db.calls.some(x=>x.sql?.includes('COURIER_BOOKED')));
});

test('shipment lookup cannot access a shipment owned by another seller',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM seller_profiles')?{user_id:sellerId,status:'APPROVED'}:undefined);
  const repo=createPostgresSellerRepository(db,{inventoryRepository:inventory});
  await assert.rejects(repo.updateSellerShipment(sellerId,'foreign-shipment','IN_TRANSIT'),e=>e.status===404&&e.code==='SHIPMENT_NOT_FOUND');
  const lookup=db.calls.find(x=>x.sql?.includes('FROM shipments sh JOIN seller_orders so'));
  assert.deepEqual(lookup.values,['foreign-shipment',sellerId]);
  assert.equal(db.calls.some(x=>x.sql?.includes('UPDATE shipments')),false);
});

test('delivery confirmation updates shipment and transitions the seller order in the same transaction',async()=>{
  const db=fakeDatabase((method,sql)=>sql.includes('FROM seller_profiles')?{user_id:sellerId,status:'APPROVED'}:sql.includes('FROM shipments sh JOIN seller_orders')?{id:'ship-1',seller_order_id:'so-1',order_id:'o-1',seller_id:sellerId,seller_order_status:'SHIPPED',provider:'PATHAO',tracking_id:'PA-123',customer_id:'buyer-1'}:undefined);
  let transition;
  const repo=createPostgresSellerRepository(db,{inventoryRepository:inventory,ordersRepository:{async transitionSellerOrder(input){transition=input;return{id:'so-1',status:'DELIVERED'};}}});
  const result=await repo.updateSellerShipment(sellerId,'ship-1','DELIVERED');
  assert.deepEqual(result,{id:'ship-1',status:'DELIVERED'});
  assert.equal(transition.sellerId,sellerId);
  assert.equal(transition.sellerOrderId,'so-1');
  assert.equal(transition.nextStatus,'DELIVERED');
  assert.ok(db.calls.some(x=>x.sql?.includes('UPDATE shipments SET status')));
});