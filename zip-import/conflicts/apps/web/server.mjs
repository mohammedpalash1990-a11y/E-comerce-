import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
const root=new URL('./public/',import.meta.url);
const port=Number(process.env.WEB_PORT||3000),apiPort=Number(process.env.PORT||4000),apiHost=process.env.API_HOST||'127.0.0.1';
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost'),pathname=decodeURIComponent(url.pathname);
  if(pathname.startsWith('/api/')){
   const upstream=http.request({hostname:apiHost,port:apiPort,path:pathname+url.search,method:req.method,headers:{...req.headers,host:apiHost+':'+apiPort}},response=>{
    res.writeHead(response.statusCode||502,response.headers);response.pipe(res);
   });
   upstream.on('error',()=>{if(!res.headersSent){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'API unavailable'}));}});
   req.pipe(upstream);return;
  }
  const route=pathname==='/'?'index.html':pathname.slice(1);
  if(route.includes('..'))throw new Error('Invalid path');
  const file=await readFile(new URL(route,root));
  res.writeHead(200,{'content-type':types[extname(route)]||'application/octet-stream','x-content-type-options':'nosniff'});
  res.end(file);
 }catch{res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('Not found')}
}).listen(port,'0.0.0.0',()=>console.log('Web storefront listening on '+port));
