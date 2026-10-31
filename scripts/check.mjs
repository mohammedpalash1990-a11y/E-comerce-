import { access, readFile } from 'node:fs/promises';
const required=['README.md','package.json','.env.example','apps/api/src/server.mjs','apps/web/server.mjs','apps/web/public/index.html','docs/STATUS_BN.md','prisma/schema.prisma'];
for(const file of required){await access(file);console.log('OK',file)}
const pkg=JSON.parse(await readFile('package.json','utf8'));
if(pkg.name!=='bangladesh-multivendor-marketplace')throw new Error('Unexpected package name');
