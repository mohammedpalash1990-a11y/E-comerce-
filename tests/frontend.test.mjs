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
    assert.ok(html.includes('href="./">'));
  }
});

test('frontend API configuration is explicit and keeps API version out of the base origin', async () => {
  const config = await read('apps/web/public/api-config.js');
  assert.match(config, /window\.HAAT_API_BASE\s*=\s*''/);
  assert.match(config, /do not append \/api\/v1/);
});

test('storefront does not silently present hard-coded demo products as live inventory', async () => {
  const html = await read('apps/web/public/index.html');
  assert.match(html, /let products=\[\]/);
  assert.match(html, /লাইভ ক্যাটালগ অফলাইন/);
  assert.match(html, /fetch\(apiUrl\('\/health'\)/);
  assert.match(html, /haat_cart_v1/);
  assert.match(html, /retryConnection/);
  assert.doesNotMatch(html, /id:'p[1-8]',bn:/);
});

test('seller and admin portals visibly report backend connectivity', async () => {
  const [seller, admin] = await Promise.all([read('apps/web/public/seller.html'), read('apps/web/public/admin.html')]);
  for (const html of [seller, admin]) {
    assert.match(html, /id="apiStatus"/);
    assert.match(html, /checkApiStatus\(\)/);
    assert.match(html, /\/health/);
  }
});

test('seller can submit product description and HTTPS image URL', async () => {
  const html = await read('apps/web/public/seller.html');
  assert.match(html, /name="image_url"/);
  assert.match(html, /name="description"/);
  assert.match(html, /images:imageUrl\?\[imageUrl\]:\[\]/);
  assert.match(html, /p\.image/);
});

test('storefront renders live product images safely when provided by API', async () => {
  const html = await read('apps/web/public/index.html');
  assert.match(html, /p\.image\?'<img class="product-image"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
});

test('admin console exposes dashboard metrics and seller application moderation', async () => {
  const html = await read('apps/web/public/admin.html');
  assert.match(html, /admin\/dashboard/);
  assert.match(html, /admin\/sellers\?status=PENDING/);
  assert.match(html, /data-seller/);
  assert.match(html, /dashboardStats/);
});
