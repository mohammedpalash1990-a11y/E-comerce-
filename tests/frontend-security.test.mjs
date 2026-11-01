import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = {
  storefront: await readFile(new URL('../apps/web/public/index.html', import.meta.url), 'utf8'),
  customer: await readFile(new URL('../apps/web/public/account.html', import.meta.url), 'utf8'),
  seller: await readFile(new URL('../apps/web/public/seller.html', import.meta.url), 'utf8'),
  admin: await readFile(new URL('../apps/web/public/admin.html', import.meta.url), 'utf8')
};

test('all portals define HTML escaping for text and attribute contexts', () => {
  for (const [name, source] of Object.entries(pages)) {
    assert.match(source, /replace\(\/[&<>"']+\/g,c=>\(\{/,
      name + ' should escape HTML metacharacters before interpolating API data');
    for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) {
      assert.ok(source.includes(entity), name + ' must escape ' + entity);
    }
  }
});

test('customer, seller and admin render API-provided content through escaping helpers', () => {
  assert.match(pages.customer, /innerHTML=.*esc\(/);
  assert.match(pages.seller, /innerHTML=.*esc\(/);
  assert.match(pages.admin, /innerHTML=.*esc\(/);
  assert.match(pages.storefront, /innerHTML=.*escHtml\(/);
});

test('customer checkout keeps browser-side required validation on delivery fields', () => {
  const form = pages.customer.match(/<form id="checkoutForm"[\s\S]*?<\/form>/)?.[0] || '';
  assert.ok(form, 'checkout form exists');
  for (const field of ['name', 'phone', 'area', 'address']) {
    const input = new RegExp('name="' + field + '"[^>]*required|name="' + field + '"[^>]*>[\\s\\S]*?required');
    assert.match(form, input, field + ' must be required');
  }
  assert.match(form, /maxlength="100"/);
  assert.match(form, /maxlength="500"/);
  assert.match(form, /role="status"/);
});

test('seller and admin logout both attempt server-side session revocation', () => {
  assert.match(pages.seller, /call\('\/auth\/logout'/);
  assert.match(pages.admin, /call\('\/auth\/logout'/);
  assert.ok(pages.seller.includes("localStorage.removeItem('haat_seller_token')"));
  assert.ok(pages.admin.includes("localStorage.removeItem('haat_admin_token')"));
});
