import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const port=Number(process.env.PORT||4000),file=resolve(process.env.SQLITE_FILE||'data/marketplace.sqlite');
mkdirSync(dirname(file),{recursive:true});
const db=new DatabaseSync(file);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,phone TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY,slug TEXT UNIQUE,name_bn TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,category_id TEXT,name_bn TEXT NOT NULL,name_en TEXT NOT NULL,price_paisa INTEGER NOT NULL,stock INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,total_paisa INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);`);
const q=s=>db.prepare(s),hash=p=>{const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(p,salt,64).toString('hex')};
if(!q('SELECT id FROM users LIMIT 1').get()){
 q('INSERT INTO users VALUES(?,?,?,?,?)').run(randomUUID(),'01700000003','Demo Customer',hash('Customer@12345'),'CUSTOMER');
 q('INSERT INTO users VALUES(?,?,?,?,?)').run(randomUUID(),'01700000002','Demo Seller',hash('Seller@12345'),'SELLER');
 q('INSERT INTO users VALUES(?,?,?,?,?)').run(randomUUID(),'01700000001','Platform Admin',hash('Admin@12345'),'ADMIN');
 for(const [slug,name] of [['electronics','ইলেকট্রনিক্স'],['fashion','ফ্যাশন'],['home','ঘর ও জীবন']])q('INSERT INTO categories VALUES(?,?,?)').run(randomUUID(),slug,name);
 const cats=q('SELECT id,slug FROM categories').all();
 for(const [name,bn,price,stock,slug] of [['Wireless Earbuds','ওয়্যারলেস ইয়ারবাড',189000,32,'electronics'],['Cotton Panjabi','কটন পাঞ্জাবি',129000,18,'fashion'],['Desk Lamp','ডেস্ক ল্যাম্প',95000,12,'home']])q('INSERT INTO products VALUES(?,?,?,?,?,?,1)').run(randomUUID(),cats.find(c=>c.slug===slug).id,bn,name,price,stock);
}
const sessions=new Map(),send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
async function read(req){let s='';for await(const c of req){s+=c;if(s.length>100000)throw Error('Payload too large')}return s?JSON.parse(s):{}}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost'),path=url.pathname;
  if(req.method==='GET'&&path==='/health')return send(res,200,{ok:true,service:'marketplace-api'});
  if(req.method==='GET'&&path==='/api/v1/categories')return send(res,200,{data:q('SELECT slug,name_bn FROM categories').all()});
  if(req.method==='GET'&&path==='/api/v1/products'){
   const term=(url.searchParams.get('q')||'').slice(0,80);
   return send(res,200,{data:q('SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.stock,c.slug category_slug FROM products p JOIN categories c ON c.id=p.category_id WHERE p.active=1 AND (p.name_bn LIKE ? OR p.name_en LIKE ?)').all('%'+term+'%','%'+term+'%').map(p=>({...p,price_bdt:p.price_paisa/100}))});
  }
  if(req.method==='POST'&&path==='/api/v1/auth/login'){
   const b=await read(req),u=q('SELECT * FROM users WHERE phone=?').get(String(b.phone||''));
   if(!u)return send(res,401,{error:'Invalid phone or password'});
   const [salt,key]=u.password.split(':'),actual=scryptSync(String(b.password||''),salt,64),expected=Buffer.from(key,'hex');
   if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return send(res,401,{error:'Invalid phone or password'});
   const token=randomUUID();sessions.set(token,u.id);return send(res,200,{token,data:{id:u.id,name:u.name,role:u.role}});
  }
  if(req.method==='POST'&&path==='/api/v1/checkout'){
   const token=(req.headers.authorization||'').replace(/^Bearer /,''),uid=sessions.get(token);if(!uid)return send(res,401,{error:'Authentication required'});
   const b=await read(req);if(!Array.isArray(b.items)||!b.items.length)return send(res,400,{error:'Cart is empty'});
   let total=0;for(const item of b.items){const p=q('SELECT * FROM products WHERE id=? AND active=1').get(item.productId);const n=Number(item.quantity);if(!p||!Number.isInteger(n)||n<1||p.stock<n)return send(res,400,{error:'Invalid item or insufficient stock'});total+=p.price_paisa*n}
   const id=randomUUID();db.exec('BEGIN IMMEDIATE');
   try{for(const item of b.items)q('UPDATE products SET stock=stock-? WHERE id=?').run(Number(item.quantity),item.productId);q('INSERT INTO orders VALUES(?,?,?,?,?)').run(id,uid,total,'CONFIRMED',new Date().toISOString());db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
   return send(res,201,{data:{orderNumber:'BD-'+id.slice(0,8).toUpperCase(),total_bdt:total/100,status:'CONFIRMED'}});
  }
  return send(res,404,{error:'Not found'});
 }catch(e){return send(res,400,{error:e.message||'Bad request'})}
});
server.listen(port,'0.0.0.0',()=>console.log('API listening on '+port));
