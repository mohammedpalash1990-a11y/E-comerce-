import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const apiPort = process.env.API_PORT || '4000';
const webPort = process.env.WEB_PORT || '3000';
const children=[
  spawn(process.execPath,['apps/api/src/server.mjs'],{cwd:root,stdio:'inherit',env:{...process.env,PORT:apiPort}}),
  spawn(process.execPath,['apps/web/server.mjs'],{cwd:root,stdio:'inherit',env:{...process.env,WEB_PORT:webPort,PORT:apiPort}})
];
for(const child of children) child.on('exit',(code)=>{if(code!==0){for(const c of children)c.kill();process.exit(code||1)}});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{for(const c of children)c.kill();process.exit(0)});
