import { randomUUID } from 'node:crypto';

function fail(status, code, message) { const error = new Error(message); error.status=status; error.code=code; return error; }
function integer(value,label) { const n=typeof value==='number'?value:Number(value); if(!Number.isSafeInteger(n)) throw fail(500,'INVALID_DATABASE_VALUE',label+' is not a safe integer'); return n; }
function limit(value, fallback=100) { const n=Number(value??fallback); return Number.isInteger(n)?Math.min(Math.max(n,1),500):fallback; }
function money(value) { return integer(value??0,'money')/100; }

export function createPostgresAdminRepository(database,{createId=randomUUID,clock=()=>new Date().toISOString()}={}) {
  if(!database||typeof database.q!=='function'||typeof database.tx!=='function') throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  const query=sql=>database.q(sql), stamp=()=>clock(), makeId=()=>createId();

  async function listPayouts({status,limit:pageSize=200}={}) {
    const state=status?String(status).toUpperCase():null;
    if(state&&!['REQUESTED','APPROVED','REJECTED'].includes(state)) throw fail(400,'INVALID_PAYOUT_STATUS','পেআউট স্ট্যাটাস সঠিক নয়');
    const rows=await query('SELECT p.id,p.seller_id,p.amount_paisa,p.method,p.account,p.status,p.note,p.created_at,p.decided_at,sp.shop_name FROM payouts p LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id'+(state?' WHERE p.status=?':'')+' ORDER BY p.created_at DESC,p.id DESC LIMIT ?').all(...(state?[state,limit(pageSize,200)]:[limit(pageSize,200)]));
    return rows.map(row=>({...row,amount_bdt:money(row.amount_paisa)}));
  }

  async function decidePayout({payoutId,actorId,decision,note=''}) {
    const action=String(decision||'').toUpperCase();
    if(!['APPROVE','REJECT'].includes(action)) throw fail(400,'INVALID_DECISION','পেআউট সিদ্ধান্ত সঠিক নয়');
    const cleanNote=String(note??'').trim().slice(0,300), at=stamp();
    return database.tx(async()=>{
      const candidate=await query('SELECT seller_id FROM payouts WHERE id=?').get(String(payoutId));
      if(!candidate) throw fail(404,'PAYOUT_NOT_FOUND','পেআউট অনুরোধ পাওয়া যায়নি');
      const seller=await query('SELECT user_id FROM seller_profiles WHERE user_id=? FOR UPDATE').get(candidate.seller_id);
      if(!seller) throw fail(404,'SELLER_NOT_FOUND','বিক্রেতা পাওয়া যায়নি');
      const payout=await query('SELECT id,seller_id,amount_paisa,status FROM payouts WHERE id=? FOR UPDATE').get(String(payoutId));
      if(!payout||payout.seller_id!==candidate.seller_id||payout.status!=='REQUESTED') throw fail(409,'PAYOUT_NOT_PENDING','পেআউট অনুরোধটি আর pending নেই');
      if(action==='APPROVE') {
        const totals=await query("SELECT COALESCE(SUM(amount_paisa),0) reserved FROM payouts WHERE seller_id=? AND id<>? AND status IN ('REQUESTED','APPROVED')").get(payout.seller_id,String(payoutId));
        const earnings=await query("SELECT COALESCE(SUM(amount_paisa),0) earned FROM transactions WHERE seller_id=? AND kind IN ('SELLER_EARNING','SELLER_REVERSAL')").get(payout.seller_id);
        const reserved=integer(totals.reserved||0,'reserved'), earned=integer(earnings.earned||0,'earned'), amount=integer(payout.amount_paisa,'payout.amount_paisa');
        if(amount+reserved>earned) throw fail(409,'INSUFFICIENT_BALANCE','পেআউট অনুমোদনের জন্য পর্যাপ্ত balance নেই');
        await query("UPDATE payouts SET status='APPROVED',decided_at=?,note=? WHERE id=? AND status='REQUESTED'").run(at,cleanNote,String(payoutId));
        await query('INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?)').run(makeId(),'PAYOUT',null,null,payout.seller_id,-amount,String(payoutId),at);
        await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)').run(makeId(),payout.seller_id,'পেআউট অনুমোদিত',money(amount)+' টাকা',at);
      } else {
        await query("UPDATE payouts SET status='REJECTED',decided_at=?,note=? WHERE id=? AND status='REQUESTED'").run(at,cleanNote,String(payoutId));
        await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)').run(makeId(),payout.seller_id,'পেআউট প্রত্যাখ্যাত',cleanNote||'আপনার পেআউট অনুরোধটি অনুমোদিত হয়নি',at);
      }
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),action==='APPROVE'?'PAYOUT_APPROVED':'PAYOUT_REJECTED','payout',String(payoutId),JSON.stringify({seller_id:payout.seller_id,amount_paisa:payout.amount_paisa,note:cleanNote}),at);
      return {id:String(payoutId),status:action==='APPROVE'?'APPROVED':'REJECTED'};
    });
  }

  function normalizePhone(value) { return String(value??'').replace(/[\s-]/g,'').replace(/^\+?88/,''); }
  function validPhone(value) { return /^01[3-9]\d{8}$/.test(value); }
  function validEmail(value) { return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)&&value.length<=160; }

  async function listCustomers({query:search='',limit:pageSize=100}={}) {
    const term='%'+String(search||'').trim().slice(0,60)+'%';
    return query("SELECT u.id,u.name,u.phone,u.email,u.status,u.created_at,(SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) orders FROM users u WHERE u.role='CUSTOMER' AND (u.name LIKE ? OR u.phone LIKE ? OR COALESCE(u.email,'') LIKE ?) ORDER BY u.created_at DESC LIMIT ?").all(term,term,term,limit(pageSize));
  }

  async function getCustomer(customerId) {
    const customer=await query("SELECT id,name,phone,email,status,phone_verified,email_verified,created_at FROM users WHERE id=? AND role='CUSTOMER'").get(String(customerId));
    if(!customer) throw fail(404,'CUSTOMER_NOT_FOUND','কাস্টমার পাওয়া যায়নি');
    const [addresses,orders]=await Promise.all([
      query('SELECT label,name,phone,address,area,is_default FROM addresses WHERE user_id=?').all(String(customerId)),
      query('SELECT COUNT(*) count FROM orders WHERE user_id=?').get(String(customerId))
    ]);
    return {...customer,addresses,order_count:integer(orders.count,'order_count')};
  }

  async function updateCustomer({customerId,actorId,body={}}) {
    const current=await query("SELECT id,name,phone,email FROM users WHERE id=? AND role='CUSTOMER'").get(String(customerId));
    if(!current) throw fail(404,'CUSTOMER_NOT_FOUND','কাস্টমার পাওয়া যায়নি');
    const name=String(body.name??current.name).trim().slice(0,100),phone=normalizePhone(body.phone??current.phone),email=String(body.email??current.email??'').trim().toLowerCase()||null;
    if(!name||!validPhone(phone)||(email&&!validEmail(email))) throw fail(400,'INVALID_CUSTOMER_DETAILS','মোবাইল, ইমেইল বা নাম সঠিক নয়');
    const duplicatePhone=await query('SELECT id FROM users WHERE id<>? AND phone=? LIMIT 1').get(String(customerId),phone);
    const duplicateEmail=email?await query('SELECT id FROM users WHERE id<>? AND lower(email)=? LIMIT 1').get(String(customerId),email):null;
    if(duplicatePhone||duplicateEmail) throw fail(409,'CUSTOMER_CONTACT_IN_USE','মোবাইল বা ইমেইল অন্য অ্যাকাউন্টে ব্যবহৃত');
    await database.tx(async()=>{
      await query('UPDATE users SET name=?,phone=?,email=? WHERE id=? AND role=\'CUSTOMER\'').run(name,phone,email,String(customerId));
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'CUSTOMER_EDIT','user',String(customerId),JSON.stringify({name,phone,email}),stamp());
    });
    return getCustomer(customerId);
  }

  async function setCustomerStatus({customerId,actorId,status}) {
    const next=String(status||'').toUpperCase();
    if(!['ACTIVE','SUSPENDED'].includes(next)) throw fail(400,'INVALID_CUSTOMER_STATUS','কাস্টমার স্ট্যাটাস সঠিক নয়');
    return database.tx(async()=>{
      const customer=await query("SELECT id FROM users WHERE id=? AND role='CUSTOMER' FOR UPDATE").get(String(customerId));
      if(!customer) throw fail(404,'CUSTOMER_NOT_FOUND','কাস্টমার পাওয়া যায়নি');
      await query('UPDATE users SET status=? WHERE id=?').run(next,String(customerId));
      if(next==='SUSPENDED') await query('DELETE FROM sessions WHERE user_id=?').run(String(customerId));
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'CUSTOMER_'+next,'user',String(customerId),'{}',stamp());
      return {id:String(customerId),status:next};
    });
  }

  async function listCustomerOrders(customerId) {
    const rows=await query('SELECT id,total_paisa,subtotal_paisa,shipping_paisa,discount_paisa,status,payment_method,payment_status,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(String(customerId));
    return rows.map(row=>({...row,orderNumber:'BD-'+String(row.id).slice(0,8).toUpperCase(),total_bdt:money(row.total_paisa),subtotal_bdt:money(row.subtotal_paisa),shipping_bdt:money(row.shipping_paisa),discount_bdt:money(row.discount_paisa)}));
  }

  async function listSellers({status,limit:pageSize=100}={}) {
    const state=status?String(status).toUpperCase():null;
    if(state&&!['PENDING','APPROVED','REJECTED','SUSPENDED'].includes(state)) throw fail(400,'INVALID_SELLER_STATUS','বিক্রেতার স্ট্যাটাস সঠিক নয়');
    const rows=await query('SELECT u.id,u.name,u.phone,u.email,u.status user_status,sp.shop_name,sp.shop_address,sp.business_info,sp.kyc_nid,sp.kyc_trade_license,sp.status,sp.commission_bps,sp.created_at FROM seller_profiles sp JOIN users u ON u.id=sp.user_id'+(state?' WHERE sp.status=?':'')+' ORDER BY sp.created_at DESC LIMIT ?').all(...(state?[state,limit(pageSize)]:[limit(pageSize)]));
    return rows;
  }

  async function getSeller(sellerId) {
    const row=await query('SELECT u.id,u.name,u.phone,u.email,u.status user_status,sp.shop_name,sp.shop_address,sp.business_info,sp.kyc_nid,sp.kyc_trade_license,sp.status,sp.commission_bps,sp.created_at FROM seller_profiles sp JOIN users u ON u.id=sp.user_id WHERE u.id=?').get(String(sellerId));
    if(!row) throw fail(404,'SELLER_NOT_FOUND','বিক্রেতা পাওয়া যায়নি');
    return row;
  }

  async function getSellerOverview(sellerId) {
    const seller=await getSeller(sellerId);
    const row=await query(`SELECT
      (SELECT COUNT(*) FROM products WHERE seller_id=? AND status<>'ARCHIVED') product_count,
      (SELECT COUNT(*) FROM seller_orders WHERE seller_id=?) order_count,
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind IN ('SELLER_EARNING','SELLER_REVERSAL')),0) earnings,
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind='COMMISSION'),0) commission,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE seller_id=? AND status='APPROVED'),0) paid,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE seller_id=? AND status IN ('REQUESTED','APPROVED')),0) reserved,
      COALESCE((SELECT SUM(net_paisa) FROM seller_orders WHERE seller_id=? AND status IN ('CONFIRMED','PROCESSING','SHIPPED')),0) pending`).get(String(sellerId),String(sellerId),String(sellerId),String(sellerId),String(sellerId),String(sellerId),String(sellerId));
    const earnings=integer(row.earnings,'earnings'),reserved=integer(row.reserved,'reserved');
    return {...seller,product_count:integer(row.product_count,'product_count'),order_count:integer(row.order_count,'order_count'),finance:{commission_bdt:money(row.commission),earned_bdt:money(earnings),available_bdt:money(earnings-reserved),paid_out_bdt:money(row.paid),pending_bdt:money(row.pending)}};
  }

  async function listSellerProducts(sellerId) {
    const rows=await query('SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,p.status FROM products p WHERE p.seller_id=? ORDER BY p.created_at DESC,p.id DESC').all(String(sellerId));
    return rows.map(row=>({...row,price_bdt:money(row.price_paisa),discount_price_bdt:row.discount_paisa==null?null:money(row.discount_paisa)}));
  }

  async function listSellerOrders(sellerId) {
    const rows=await query('SELECT id,order_id,status,subtotal_paisa,commission_paisa,net_paisa,created_at FROM seller_orders WHERE seller_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(String(sellerId));
    return rows.map(row=>({...row,orderNumber:'BD-'+String(row.order_id).slice(0,8).toUpperCase(),subtotal_bdt:money(row.subtotal_paisa),commission_bdt:money(row.commission_paisa),net_bdt:money(row.net_paisa)}));
  }

  async function listProducts({status,query:search='',limit:pageSize=100}={}) {
    const state=status?String(status).toUpperCase():null;
    const term='%'+String(search||'').trim().slice(0,80)+'%';
    const rows=await query(`SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,p.status,c.slug category_slug,sp.shop_name seller_name
      FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id
      WHERE p.status<>'ARCHIVED' AND (p.name_bn LIKE ? OR p.name_en LIKE ?)${state?' AND p.status=?':''}
      ORDER BY p.created_at DESC,p.id DESC LIMIT ?`).all(...(state?[term,term,state,limit(pageSize)]:[term,term,limit(pageSize)]));
    return rows.map(row=>({...row,price_bdt:money(row.price_paisa),discount_price_bdt:row.discount_paisa==null?null:money(row.discount_paisa)}));
  }

  async function decideSeller({sellerId,actorId,decision,reason=''}) {
    const action=String(decision||'').toUpperCase();
    const states={APPROVE:['APPROVED','ACTIVE'],REJECT:['REJECTED','ACTIVE'],SUSPEND:['SUSPENDED','SUSPENDED'],ACTIVATE:['APPROVED','ACTIVE']};
    if(!states[action]) throw fail(400,'INVALID_SELLER_DECISION','বিক্রেতার সিদ্ধান্ত সঠিক নয়');
    const [sellerStatus,userStatus]=states[action],why=String(reason??'').trim().slice(0,300),at=stamp();
    return database.tx(async()=>{
      const seller=await query('SELECT user_id,status FROM seller_profiles WHERE user_id=? FOR UPDATE').get(String(sellerId));
      if(!seller) throw fail(404,'SELLER_NOT_FOUND','বিক্রেতা পাওয়া যায়নি');
      await query('UPDATE seller_profiles SET status=? WHERE user_id=?').run(sellerStatus,String(sellerId));
      await query('UPDATE users SET status=? WHERE id=?').run(userStatus,String(sellerId));
      if(userStatus==='SUSPENDED') await query('DELETE FROM sessions WHERE user_id=?').run(String(sellerId));
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'SELLER_'+sellerStatus,'seller',String(sellerId),JSON.stringify({reason:why}),at);
      await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)').run(makeId(),String(sellerId),'বিক্রেতা অ্যাকাউন্ট: '+sellerStatus,why,at);
      return {id:String(sellerId),status:sellerStatus};
    });
  }

  async function setCommission({sellerId,actorId,commissionBps}) {
    const bps=Number(commissionBps);
    if(!Number.isInteger(bps)||bps<0||bps>5000) throw fail(400,'INVALID_COMMISSION','কমিশন ০–৫০% এর মধ্যে হতে হবে');
    return database.tx(async()=>{
      const seller=await query('SELECT user_id FROM seller_profiles WHERE user_id=? FOR UPDATE').get(String(sellerId));
      if(!seller) throw fail(404,'SELLER_NOT_FOUND','বিক্রেতা পাওয়া যায়নি');
      await query('UPDATE seller_profiles SET commission_bps=? WHERE user_id=?').run(bps,String(sellerId));
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'COMMISSION_SET','seller',String(sellerId),JSON.stringify({commission_bps:bps}),stamp());
      return {id:String(sellerId),commission_bps:bps};
    });
  }

  async function listCategories() {
    return query('SELECT id,slug,name_bn,name_en FROM categories ORDER BY name_bn').all();
  }

  async function createCategory({actorId,nameBn,nameEn='',slug=''}) {
    const bn=String(nameBn??'').trim().slice(0,80),en=String(nameEn??'').trim().slice(0,80);
    const key=String(slug||en||bn).trim().toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]+/g,'-').replace(/^-|-$/g,'').slice(0,80);
    if(!bn||!key) throw fail(400,'INVALID_CATEGORY','ক্যাটাগরির নাম ও slug সঠিক নয়');
    const id=makeId();
    await database.tx(async()=>{
      await query('INSERT INTO categories(id,slug,name_bn,name_en) VALUES(?,?,?,?)').run(id,key,bn,en);
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'CATEGORY_CREATE','category',id,JSON.stringify({slug:key}),stamp());
    });
    return {id,slug:key};
  }

  async function updateCategory({actorId,slug,nameBn,nameEn=''}) {
    const bn=String(nameBn??'').trim().slice(0,80),en=String(nameEn??'').trim().slice(0,80);
    if(!bn) throw fail(400,'INVALID_CATEGORY','বাংলা নাম দিতে হবে');
    const result=await query('UPDATE categories SET name_bn=?,name_en=? WHERE slug=?').run(bn,en,String(slug));
    if(!result.changes) throw fail(404,'CATEGORY_NOT_FOUND','ক্যাটাগরি পাওয়া যায়নি');
    await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'CATEGORY_EDIT','category',String(slug),'{}',stamp());
    return {slug:String(slug)};
  }

  async function deleteCategory({actorId,slug}) {
    return database.tx(async()=>{
      const category=await query('SELECT id FROM categories WHERE slug=? FOR UPDATE').get(String(slug));
      if(!category) throw fail(404,'CATEGORY_NOT_FOUND','ক্যাটাগরি পাওয়া যায়নি');
      const product=await query('SELECT id FROM products WHERE category_id=? LIMIT 1').get(category.id);
      if(product) throw fail(409,'CATEGORY_IN_USE','এই ক্যাটাগরিতে পণ্য আছে');
      await query('DELETE FROM categories WHERE id=?').run(category.id);
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'CATEGORY_DELETE','category',String(slug),'{}',stamp());
      return {deleted:true};
    });
  }

  async function listBrands() { return query('SELECT id,slug,name FROM brands ORDER BY name').all(); }

  async function createBrand({actorId,name}) {
    const label=String(name??'').trim().slice(0,80),slug=label.toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]+/g,'-').replace(/^-|-$/g,'').slice(0,80);
    if(!label||!slug) throw fail(400,'INVALID_BRAND','ব্র্যান্ডের নাম সঠিক নয়');
    const id=makeId();
    await database.tx(async()=>{
      await query('INSERT INTO brands(id,slug,name) VALUES(?,?,?)').run(id,slug,label);
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'BRAND_CREATE','brand',id,JSON.stringify({slug}),stamp());
    });
    return {id,slug};
  }

  async function deleteBrand({actorId,slug}) {
    return database.tx(async()=>{
      const brand=await query('SELECT id FROM brands WHERE slug=? FOR UPDATE').get(String(slug));
      if(!brand) throw fail(404,'BRAND_NOT_FOUND','ব্র্যান্ড পাওয়া যায়নি');
      await query('UPDATE products SET brand_id=NULL WHERE brand_id=?').run(brand.id);
      await query('DELETE FROM brands WHERE id=?').run(brand.id);
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'BRAND_DELETE','brand',String(slug),'{}',stamp());
      return {deleted:true};
    });
  }

  async function listCoupons() { return query('SELECT code,type,value,min_order_paisa,max_uses,used_count,expires_at,active FROM coupons ORDER BY code').all(); }

  async function createCoupon({actorId,body={}}) {
    const code=String(body.code??'').trim().toUpperCase();
    if(!/^[A-Z0-9_-]{1,30}$/.test(code)) throw fail(400,'INVALID_COUPON_CODE','কুপন কোড সঠিক নয়');
    const type=String(body.type||'PERCENT').toUpperCase()==='FIXED'?'FIXED':'PERCENT';
    const value=type==='FIXED'?Math.round(Number(body.value)*100):Number(body.value);
    if(!Number.isSafeInteger(value)||value<=0||(type==='PERCENT'&&value>90)) throw fail(400,'INVALID_COUPON_VALUE','কুপনের ছাড়ের পরিমাণ সঠিক নয়');
    const minimum=Math.round(Number(body.min_order_bdt||0)*100);
    if(!Number.isSafeInteger(minimum)||minimum<0) throw fail(400,'INVALID_COUPON_MINIMUM','ন্যূনতম অর্ডার সঠিক নয়');
    const maxUses=body.max_uses==null||body.max_uses===''?null:Number(body.max_uses);
    if(maxUses!==null&&(!Number.isSafeInteger(maxUses)||maxUses<1)) throw fail(400,'INVALID_COUPON_LIMIT','ব্যবহারের সীমা সঠিক নয়');
    const expires=body.expires_at?String(body.expires_at):null;
    await database.tx(async()=>{
      await query('INSERT INTO coupons(code,type,value,min_order_paisa,max_uses,used_count,expires_at,active) VALUES(?,?,?,?,?,0,?,1)').run(code,type,value,minimum,maxUses,expires);
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'COUPON_CREATE','coupon',code,JSON.stringify({type,value}),stamp());
    });
    return {code};
  }

  async function toggleCoupon({actorId,code,active}) {
    const result=await query('UPDATE coupons SET active=? WHERE code=?').run(active?1:0,String(code).toUpperCase());
    if(!result.changes) throw fail(404,'COUPON_NOT_FOUND','কুপন পাওয়া যায়নি');
    await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'COUPON_TOGGLE','coupon',String(code).toUpperCase(),JSON.stringify({active:Boolean(active)}),stamp());
    return {code:String(code).toUpperCase(),active:Boolean(active)};
  }

  async function listPendingProducts() {
    return query("SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,p.status,c.slug category_slug,COALESCE(sp.shop_name,u.name) seller_name,(SELECT url FROM product_images i WHERE i.product_id=p.id ORDER BY position LIMIT 1) image FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN users u ON u.id=p.seller_id LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id WHERE p.status='PENDING_REVIEW' ORDER BY p.created_at,p.id").all();
  }

  async function moderateProduct({productId,actorId,decision,reason=''}) {
    const action=String(decision||'').toUpperCase();
    const transitions={APPROVE:{to:'ACTIVE',from:['PENDING_REVIEW']},REJECT:{to:'REJECTED',from:['PENDING_REVIEW']},SUSPEND:{to:'SUSPENDED',from:['ACTIVE']},UNSUSPEND:{to:'ACTIVE',from:['SUSPENDED']}};
    const selected=transitions[action];
    if(!selected) throw fail(400,'INVALID_PRODUCT_DECISION','পণ্যের সিদ্ধান্ত সঠিক নয়');
    const why=String(reason??'').trim().slice(0,300),at=stamp();
    return database.tx(async()=>{
      const product=await query('SELECT id,seller_id,status FROM products WHERE id=? FOR UPDATE').get(String(productId));
      if(!product||!selected.from.includes(product.status)) throw fail(409,'PRODUCT_NOT_MODERATABLE','পণ্যটি এই সিদ্ধান্তের জন্য উপযুক্ত নয়');
      if(selected.to==='ACTIVE') {
        const seller=await query('SELECT status FROM seller_profiles WHERE user_id=? FOR UPDATE').get(product.seller_id);
        if(seller?.status!=='APPROVED') throw fail(409,'SELLER_NOT_APPROVED','আগে বিক্রেতাকে অনুমোদন দিতে হবে');
      }
      await query('UPDATE products SET status=?,active=?,updated_at=? WHERE id=?').run(selected.to,selected.to==='ACTIVE'?1:0,at,String(productId));
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'PRODUCT_'+selected.to,'product',String(productId),JSON.stringify({reason:why}),at);
      if(product.seller_id) await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)').run(makeId(),product.seller_id,'পণ্যের স্ট্যাটাস: '+selected.to,why,at);
      return {id:String(productId),status:selected.to};
    });
  }

  async function applyRefund({order,refund,actorId}) {
    const amount=integer(refund.amount_paisa,'refund.amount_paisa'),total=integer(order.total_paisa,'order.total_paisa');
    const refunded=await query("SELECT COALESCE(SUM(amount_paisa),0) amount FROM refunds WHERE order_id=? AND status='APPROVED'").get(order.id);
    const already=integer(refunded.amount||0,'refunded.amount');
    if(amount<=0||already+amount>total) throw fail(409,'REFUND_LIMIT_EXCEEDED','রিফান্ডের পরিমাণ অবশিষ্ট পরিশোধিত অর্থের বেশি');
    const at=stamp();
    await query("UPDATE refunds SET status='APPROVED',decided_at=? WHERE id=? AND status='REQUESTED'").run(at,refund.id);
    await query('INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?)').run(makeId(),'REFUND',order.id,null,null,-amount,String(refund.id),at);
    const delivered=await query("SELECT id,seller_id,net_paisa FROM seller_orders WHERE order_id=? AND status='DELIVERED' FOR UPDATE").all(order.id);
    for(const sellerOrder of delivered) {
      const reversal=Math.round(integer(sellerOrder.net_paisa,'seller_order.net_paisa')*amount/total);
      if(reversal>0) await query('INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?)').run(makeId(),'SELLER_REVERSAL',order.id,sellerOrder.id,sellerOrder.seller_id,-reversal,String(refund.id)+':'+sellerOrder.id,at);
    }
    const next=already+amount>=total?'REFUNDED':'PARTIALLY_REFUNDED';
    await query('UPDATE orders SET payment_status=? WHERE id=?').run(next,order.id);
    if(next==='REFUNDED') await query("UPDATE payments SET status='REFUNDED',updated_at=? WHERE order_id=? AND status='PAID'").run(at,order.id);
    await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'REFUND_APPROVED','refund',String(refund.id),JSON.stringify({order_id:order.id,amount_paisa:amount}),at);
    await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)').run(makeId(),order.user_id,'রিফান্ড অনুমোদিত','BD-'+String(order.id).slice(0,8).toUpperCase()+': '+money(amount)+' টাকা',at);
    return {id:String(refund.id),status:'APPROVED'};
  }

  async function createRefund({orderId,actorId,amountBdt,reason=''}) {
    const amount=Number(amountBdt),paisa=Math.round(amount*100);
    if(!Number.isFinite(amount)||!Number.isSafeInteger(paisa)||paisa<=0||Math.abs(amount*100-paisa)>1e-7) throw fail(400,'INVALID_REFUND_AMOUNT','রিফান্ড পরিমাণ সঠিক নয়');
    const why=String(reason??'').trim().slice(0,300),refundId=makeId();
    return database.tx(async()=>{
      const order=await query('SELECT id,user_id,total_paisa,payment_status FROM orders WHERE id=? FOR UPDATE').get(String(orderId));
      if(!order) throw fail(404,'ORDER_NOT_FOUND','অর্ডার পাওয়া যায়নি');
      if(!['PAID','PARTIALLY_REFUNDED'].includes(order.payment_status)) throw fail(409,'ORDER_NOT_REFUNDABLE','পেমেন্ট সম্পন্ন না হলে রিফান্ড করা যায় না');
      const at=stamp();
      await query('INSERT INTO refunds(id,order_id,amount_paisa,reason,status,created_at,decided_at) VALUES(?,?,?,?,?,?,NULL)').run(refundId,order.id,paisa,why,'REQUESTED',at);
      return applyRefund({order,refund:{id:refundId,amount_paisa:paisa},actorId});
    });
  }

  async function approveRefund({refundId,actorId}) {
    return database.tx(async()=>{
      const candidate=await query('SELECT order_id FROM refunds WHERE id=?').get(String(refundId));
      if(!candidate) throw fail(404,'REFUND_NOT_FOUND','রিফান্ড অনুরোধ পাওয়া যায়নি');
      const order=await query('SELECT id,user_id,total_paisa,payment_status FROM orders WHERE id=? FOR UPDATE').get(candidate.order_id);
      const refund=await query('SELECT id,order_id,amount_paisa,status FROM refunds WHERE id=? FOR UPDATE').get(String(refundId));
      if(!refund||refund.status!=='REQUESTED') throw fail(409,'REFUND_NOT_PENDING','রিফান্ড অনুরোধটি আর pending নেই');
      if(!order) throw fail(404,'ORDER_NOT_FOUND','অর্ডার পাওয়া যায়নি');
      if(!['PAID','PARTIALLY_REFUNDED'].includes(order.payment_status)) throw fail(409,'ORDER_NOT_REFUNDABLE','অর্ডারটি রিফান্ডযোগ্য নয়');
      return applyRefund({order,refund,actorId});
    });
  }

  async function rejectRefund({refundId,actorId}) {
    return database.tx(async()=>{
      const candidate=await query('SELECT order_id FROM refunds WHERE id=?').get(String(refundId));
      if(!candidate) throw fail(404,'REFUND_NOT_FOUND','রিফান্ড অনুরোধ পাওয়া যায়নি');
      await query('SELECT id FROM orders WHERE id=? FOR UPDATE').get(candidate.order_id);
      const refund=await query("SELECT id,status FROM refunds WHERE id=? FOR UPDATE").get(String(refundId));
      if(!refund||refund.status!=='REQUESTED') throw fail(409,'REFUND_NOT_PENDING','রিফান্ড অনুরোধটি আর pending নেই');
      const at=stamp();
      await query("UPDATE refunds SET status='REJECTED',decided_at=? WHERE id=? AND status='REQUESTED'").run(at,String(refundId));
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'REFUND_REJECTED','refund',String(refundId),'{}',at);
      return {id:String(refundId),status:'REJECTED'};
    });
  }

  async function setShippingCharge({orderId,actorId,shippingBdt}) {
    const amount=Number(shippingBdt),shipping=Math.round(amount*100);
    if(!Number.isFinite(amount)||!Number.isSafeInteger(shipping)||shipping<0||shipping>1e7||Math.abs(amount*100-shipping)>1e-7) throw fail(400,'INVALID_SHIPPING_CHARGE','ডেলিভারি চার্জ সঠিক নয়');
    return database.tx(async()=>{
      const order=await query('SELECT id,subtotal_paisa,shipping_paisa,discount_paisa,total_paisa,payment_status,status FROM orders WHERE id=? FOR UPDATE').get(String(orderId));
      if(!order) throw fail(404,'ORDER_NOT_FOUND','অর্ডার পাওয়া যায়নি');
      if(order.payment_status!=='PENDING'||!['AWAITING_PAYMENT','CONFIRMED','PROCESSING'].includes(order.status)) throw fail(409,'ORDER_SHIPPING_LOCKED','এই অর্ডারে ডেলিভারি চার্জ পরিবর্তন করা যাবে না');
      const total=integer(order.subtotal_paisa,'subtotal_paisa')+shipping-integer(order.discount_paisa,'discount_paisa');
      if(total<0) throw fail(409,'INVALID_ORDER_TOTAL','অর্ডারের মোট মূল্য ঋণাত্মক হতে পারে না');
      await query('UPDATE orders SET shipping_paisa=?,total_paisa=? WHERE id=?').run(shipping,total,String(orderId));
      await query("UPDATE payments SET amount_paisa=? WHERE order_id=? AND status IN ('PENDING','INITIATED')").run(total,String(orderId));
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),'SHIPPING_CHARGE_SET','order',String(orderId),JSON.stringify({from:order.shipping_paisa,to:shipping}),stamp());
      return {id:String(orderId),shipping_bdt:money(shipping),total_bdt:money(total)};
    });
  }

  async function listRefunds({limit:pageSize=200}={}) {
    const rows=await query('SELECT id,order_id,amount_paisa,reason,status,created_at,decided_at FROM refunds ORDER BY created_at DESC,id DESC LIMIT ?').all(limit(pageSize,200));
    return rows.map(row=>({...row,orderNumber:'BD-'+String(row.order_id).slice(0,8).toUpperCase(),amount_bdt:money(row.amount_paisa)}));
  }

  async function financeSummary() {
    const row=await query(`SELECT
      COALESCE((SELECT SUM(total_paisa) FROM orders WHERE status NOT IN ('CANCELLED','AWAITING_PAYMENT')),0) gross,
      COALESCE((SELECT SUM(amount_paisa) FROM refunds WHERE status='APPROVED'),0) refunds,
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE kind='COMMISSION'),0) commission,
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE kind IN ('SELLER_EARNING','SELLER_REVERSAL')),0) seller_earnings,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE status='APPROVED'),0) paid_out,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE status='REQUESTED'),0) pending_payouts,
      COALESCE((SELECT SUM(net_paisa) FROM seller_orders WHERE status IN ('CONFIRMED','PROCESSING','SHIPPED')),0) seller_pending`).get();
    const gross=integer(row.gross,'gross'),refunds=integer(row.refunds,'refunds');
    return {gross_sales_bdt:money(gross),refunds_bdt:money(refunds),net_sales_bdt:money(gross-refunds),platform_commission_bdt:money(row.commission),seller_earned_bdt:money(row.seller_earnings),seller_available_balance_bdt:money(integer(row.seller_earnings,'seller_earnings')-integer(row.paid_out,'paid_out')-integer(row.pending_payouts,'pending_payouts')),seller_pending_balance_bdt:money(row.seller_pending),paid_out_bdt:money(row.paid_out),pending_payouts_bdt:money(row.pending_payouts)};
  }

  async function listTransactions({kind,limit:pageSize=200}={}) {
    const selected=kind?String(kind).toUpperCase():null;
    const rows=await query('SELECT id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at FROM transactions'+(selected?' WHERE kind=?':'')+' ORDER BY created_at DESC,id DESC LIMIT ?').all(...(selected?[selected,limit(pageSize,200)]:[limit(pageSize,200)]));
    return rows.map(row=>({...row,amount_bdt:money(row.amount_paisa)}));
  }

  async function financeReport({from='0000-01-01',to='9999-12-31'}={}) {
    const start=String(from).slice(0,10),end=String(to).slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end) throw fail(400,'INVALID_DATE_RANGE','তারিখের সীমা সঠিক নয়');
    const rows=await query("SELECT substr(created_at,1,10) day,COUNT(*) orders,COALESCE(SUM(total_paisa),0) gross FROM orders WHERE status NOT IN('CANCELLED','AWAITING_PAYMENT') AND created_at>=? AND created_at<? GROUP BY substr(created_at,1,10) ORDER BY day").all(start,end+'T99');
    return rows.map(row=>({day:row.day,orders:integer(row.orders,'orders'),gross_bdt:money(row.gross)}));
  }

  async function listAuditLogs({limit:pageSize=200}={}) {
    return query('SELECT id,actor_id,action,entity,entity_id,detail,created_at FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT ?').all(limit(pageSize,200));
  }

  async function dashboard() {
    const row=await query(`SELECT
      (SELECT COALESCE(SUM(total_paisa),0) FROM orders WHERE payment_status='PAID' AND status<>'CANCELLED') revenue,
      (SELECT COUNT(*) FROM orders WHERE status<>'AWAITING_PAYMENT') orders,
      (SELECT COUNT(*) FROM users WHERE role='CUSTOMER') customers,
      (SELECT COUNT(*) FROM seller_profiles) sellers,
      (SELECT COUNT(*) FROM seller_profiles WHERE status='PENDING') pending_sellers,
      (SELECT COUNT(*) FROM products WHERE status='PENDING_REVIEW') pending_products,
      (SELECT COUNT(*) FROM products WHERE status<>'ARCHIVED') products,
      (SELECT COUNT(*) FROM products WHERE status='ACTIVE' AND active=1) active_products,
      (SELECT COUNT(*) FROM orders WHERE status='CANCELLED') cancelled_orders,
      (SELECT COUNT(*) FROM payouts WHERE status='REQUESTED') pending_payouts,
      (SELECT COALESCE(SUM(amount_paisa),0) FROM payouts WHERE status='REQUESTED') pending_payout_amount,
      (SELECT COALESCE(SUM(amount_paisa),0) FROM transactions WHERE kind='COMMISSION') commission`).get();
    return {total_revenue_bdt:money(row.revenue),total_orders:integer(row.orders,'orders'),total_customers:integer(row.customers,'customers'),total_sellers:integer(row.sellers,'sellers'),pending_seller_applications:integer(row.pending_sellers,'pending_sellers'),pending_product_approvals:integer(row.pending_products,'pending_products'),total_products:integer(row.products,'products'),active_products:integer(row.active_products,'active_products'),cancelled_orders:integer(row.cancelled_orders,'cancelled_orders'),pending_payouts:integer(row.pending_payouts,'pending_payouts'),pending_payout_amount_bdt:money(row.pending_payout_amount),platform_commission_bdt:money(row.commission)};
  }

  return Object.freeze({listPayouts,decidePayout,listCustomers,getCustomer,updateCustomer,setCustomerStatus,listCustomerOrders,listSellers,getSeller,getSellerOverview,listSellerProducts,listSellerOrders,listProducts,decideSeller,setCommission,listCategories,createCategory,updateCategory,deleteCategory,listBrands,createBrand,deleteBrand,listCoupons,createCoupon,toggleCoupon,listPendingProducts,moderateProduct,setShippingCharge,listRefunds,createRefund,approveRefund,rejectRefund,financeSummary,listTransactions,financeReport,listAuditLogs,dashboard});
}
