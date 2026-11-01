import { access, readFile } from 'node:fs/promises';
const required=['README.md','package.json','.env.example','apps/api/src/server.mjs','apps/web/server.mjs','apps/web/public/index.html','apps/web/public/seller.html','apps/web/public/admin.html','apps/web/public/api-config.js','docs/STATUS_BN.md','docs/DEPLOYMENT.md','docs/GO_LIVE_CHECKLIST_BN.md','tests/frontend.test.mjs','tests/production-guard.test.mjs','prisma/schema.prisma'];
for(const file of required){await access(file);console.log('OK',file)}
const pkg=JSON.parse(await readFile('package.json','utf8'));
if(pkg.name!=='bangladesh-multivendor-marketplace')throw new Error('Unexpected package name');
