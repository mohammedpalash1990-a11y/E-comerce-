import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const required=['README.md','package.json','.env.example','apps/api/src/server.mjs','apps/api/src/core.mjs','apps/web/server.mjs','apps/web/public/index.html','docs/STATUS_BN.md','prisma/schema.prisma','apps/api/migrations/sqlite/001_init.sql'];
for(const file of required){await access(file);console.log('OK',file)}
const pkg=JSON.parse(await readFile('package.json','utf8'));
if(pkg.name!=='bangladesh-multivendor-marketplace')throw new Error('Unexpected package name');
for(const f of (await readdir('apps/api/src')).filter(n=>n.endsWith('.mjs'))){
  const r=spawnSync(process.execPath,['--check','apps/api/src/'+f]);
  if(r.status!==0)throw new Error('Syntax error in '+f+'\n'+r.stderr);
  console.log('SYNTAX OK apps/api/src/'+f);
}
