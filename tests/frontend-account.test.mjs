import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const account = await readFile(new URL('../apps/web/public/account.html', import.meta.url), 'utf8');
const storefront = await readFile(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');

test('customer account portal exposes login, registration and password recovery', () => {
  for (const id of ['loginForm', 'registerForm', 'forgotForm', 'resetForm']) {
    assert.match(account, new RegExp('id="' + id + '"'));
  }
  for (const route of ['/auth/login', '/auth/register', '/auth/forgot-password', '/auth/reset-password', '/auth/me']) {
    assert.ok(account.includes(route), 'missing auth workflow ' + route);
  }
  assert.match(account, /portal:'CUSTOMER'/);
});

test('customer account portal connects profile, address, cart, wishlist and order workflows', () => {
  for (const route of [
    '/me', '/auth/change-password', '/customer/addresses', '/customer/cart',
    '/customer/wishlist', '/customer/orders', '/tracking', '/cancel', '/checkout'
  ]) assert.ok(account.includes(route), 'missing customer API workflow ' + route);
  for (const id of ['profileForm', 'addressForm', 'cartList', 'wishlistList', 'orderList']) {
    assert.match(account, new RegExp('id="' + id + '"'));
  }
});

test('customer account checkout supports COD and sandbox-only online payment methods', () => {
  for (const method of ['COD', 'BKASH', 'NAGAD', 'ROCKET', 'SSLCOMMERZ']) {
    assert.match(account, new RegExp('value="' + method + '"'));
  }
  assert.ok(account.includes('/payments/sandbox/'));
  assert.ok(account.includes('/customer/orders/'));
  assert.ok(account.includes('simulateSandboxPayment'));
  assert.ok(account.includes('বাস্তব লেনদেন নয়'));
});

test('customer form controls are accessed without colliding with native form properties', () => {
  assert.ok(account.includes("field(f,'name').value"));
  assert.ok(account.includes("field(f,'id').value"));
  assert.ok(account.includes("field(f,'is_default').checked"));
  assert.equal(account.includes('f.name.value'), false);
  assert.equal(account.includes('f.id.value'), false);
  assert.equal(account.includes('f.email.value'), false);
});

test('storefront links to the customer account portal without removing catalog or cart', () => {
  assert.match(storefront, /href="account\.html"/);
  assert.match(storefront, /id="products"/);
  assert.match(storefront, /id="openCart"/);
  assert.match(storefront, /haat_cart_v1/);
});

test('customer account inline JavaScript parses without syntax errors', () => {
  const scripts = account.split('<script').slice(1).map(part => {
    const open = part.indexOf('>');
    const close = part.indexOf('</script>');
    return open >= 0 && close > open ? part.slice(open + 1, close).trim() : '';
  }).filter(Boolean);
  assert.ok(scripts.length > 0, 'expected inline account application script');
  for (const script of scripts) new vm.Script(script, { filename: 'account.html:inline-script' });
});
