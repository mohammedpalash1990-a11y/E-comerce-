import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('storefront escapes API product text before HTML rendering', async () => {
  const html = await read('apps/web/public/index.html');
  assert.match(html, /escHtml\(p\.bn\)/);
  assert.match(html, /escHtml\(p\.en\)/);
  assert.match(html, /escHtml\(p\.id\)/);
  assert.match(html, /escHtml\(p\.bn\).*cartline/s);
});

test('seller and admin login forms do not expose demo credentials as defaults', async () => {
  const [seller, admin] = await Promise.all([read('apps/web/public/seller.html'), read('apps/web/public/admin.html')]);
  for (const html of [seller, admin]) {
    assert.doesNotMatch(html, /value="(?:0170000000[12]|(?:Seller|Admin)@12345)"/);
    assert.match(html, /href="\.\/">);
  }
});

test('frontend API configuration is explicit and keeps API version out of the base origin', async () => {
  const config = await read('apps/web/public/api-config.js');
  assert.match(config, /window\.HAAT_API_BASE\s*=\s*''/);
  assert.match(config, /Do not add \/api\/v1/);
});
