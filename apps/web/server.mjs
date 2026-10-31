import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const root=new URL('./public/',import.meta.url);
const port=Number(process.env.WEB_PORT||3000);
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
 try{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const route=pathname==='/'?'index.html':pathname.slice(1);
  if(route.includes('..'))throw new Error('Invalid path');
  const file=await readFile(new URL(route,root));
  res.writeHead(200,{'content-type':types[extname(route)]||'application/octet-stream','x-content-type-options':'nosniff'});
  res.end(file);
 }catch{res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('Not found')}
}).listen(port,'0.0.0.0',()=>console.log('Web storefront listening on '+port));
