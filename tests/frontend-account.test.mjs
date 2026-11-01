import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const account = await readFile(new URL('../apps/web/public/account.html', import.meta.url), 'utf8');
const storefront = await readFile(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');

test('customer account portal exposes login, registration and password recovery', () => {
  for (const id of ['loginForm','registerForm','forgotForm','resetForm']) {
    assert.match(account, new RegExp('id="' + id + '"'));
  }
  assert.match(account, /portal:'CUSTOMER'/);
  assert.match(account, /\/auth\/forgot-password/);
  assert.match(account, /\/auth\/reset-password/);
});

test('customer portal connects profile, address, cart, wishlist and order workflows', () => {
  for (const path of [
    '/auth/me','/me','/auth/change-password',
    '/customer/addresses','/customer/cart','/customer/wishlist',
    '/customer/orders','/tracking','/cancel','/checkout'
  ]) assert.ok(account.includes(path), 'missing API workflow: ' + path);
  for (const id of ['profileForm','addressForm','cartList','wishlistList','orderList']) {
    assert.match(account, new RegExp('id="' + id + '"'));
  }
});

test('storefront keeps its existing product section and links to account portal', () => {
  assert.match(storefront, /id="products"/);
  assert.match(storefront, /href="account\.html"/);
  assert.match(storefront, /haat_cart_v1/);
});

test('customer account inline JavaScript parses without syntax errors', async () => {
  const vm = await import('node:vm');
  const scripts = [...account.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)]
    .map(match => match[1].trim()).filter(Boolean);
  assert.ok(scripts.length > 0, 'expected inline account application script');
  for (const script of scripts) new vm.Script(script, { filename: 'account.html:inline-script' });
});
