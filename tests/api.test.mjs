import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const port=4417,child=spawn(process.execPath,['apps/api/src/server.mjs'],{env:{...process.env,PORT:String(port),SQLITE_FILE:':memory:'},stdio:'ignore'});
test('health and public catalog endpoints respond',async(t)=>{
 t.after(()=>child.kill());
 let ready=false;
 for(let i=0;i<40;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/health');if(r.ok){ready=true;break}}catch{}await delay(100)}
 assert.equal(ready,true,'API should start');
 const health=await fetch('http://127.0.0.1:'+port+'/health').then(r=>r.json());assert.equal(health.ok,true);
 const products=await fetch('http://127.0.0.1:'+port+'/api/v1/products').then(r=>r.json());assert.ok(products.data.length>0);
});
