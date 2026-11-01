import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const account = await readFile(new URL('../apps/web/public/account.html', import.meta.url), 'utf8');
const storefront = await readFile(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');

test('customer checkout uses saved addresses and structured delivery details', () => {
  for (const id of ['checkoutPanel','checkoutForm','checkoutAddress','couponCode','applyCoupon','checkoutMsg']) assert.ok(account.includes('id="'+id+'"'));
  for (const field of ['payment_method','coupon_code','name','phone','area','address']) assert.ok(account.includes('name="'+field+'"'));
  assert.ok(account.includes('/customer/addresses'));
  assert.ok(account.includes('/checkout'));
  assert.ok(!account.includes('const address=prompt('));
});

test('customer checkout validates coupon and supports all configured payment methods', () => {
  assert.ok(account.includes('/coupons/validate'));
  for (const method of ['COD','BKASH','NAGAD','ROCKET','SSLCOMMERZ']) assert.ok(account.includes('value="'+method+'"'));
  assert.ok(account.includes('redirect_url'));
  assert.ok(account.includes('Sandbox payment'));
});

test('customer can submit verified-purchase product reviews after delivery', () => {
  assert.ok(account.includes('/customer/products/'));
  assert.ok(account.includes('/reviews'));
  assert.ok(account.includes("x.status==='DELIVERED'"));
  assert.ok(account.includes('reviewForms'));
});

test('storefront supports adding products to wishlist with login continuation', () => {
  assert.ok(storefront.includes('data-wish'));
  assert.ok(storefront.includes('customer/wishlist'));
  assert.ok(storefront.includes('account.html?wishlist='));
});

test('customer and storefront inline JavaScript parses without syntax errors', async () => {
  for (const [name, source] of [['account.html', account], ['index.html', storefront]]) {
    const scripts = source.split('<script').slice(1).map(part => {
      const open = part.indexOf('>');
      const close = part.indexOf('</script>');
      return open >= 0 && close > open ? part.slice(open + 1, close).trim() : '';
    }).filter(Boolean);
    assert.ok(scripts.length > 0);
    for (const script of scripts) new vm.Script(script, { filename: name + ':inline-script' });
  }
});
