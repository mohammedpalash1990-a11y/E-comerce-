import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const account = await readFile(new URL('../apps/web/public/account.html', import.meta.url), 'utf8');
const storefront = await readFile(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');

test('customer checkout uses saved addresses and structured delivery details', () => {
  for (const id of ['checkoutPanel','checkoutForm','checkoutAddress','couponCode','applyCoupon','checkoutMsg']) assert.match(account, new RegExp('id="'+id+'"'));
  for (const field of ['payment_method','coupon_code','name','phone','area','address']) assert.ok(account.includes('name="'+field+'"'));
  assert.match(account, //customer/addresses/);
  assert.match(account, //checkout/);
  assert.doesNotMatch(account, /const address=prompt\(/);
});

test('customer checkout validates coupon and supports all configured payment methods', () => {
  assert.match(account, //coupons/validate/);
  for (const method of ['COD','BKASH','NAGAD','ROCKET','SSLCOMMERZ']) assert.ok(account.includes('value="'+method+'"'));
  assert.match(account, /redirect_url/);
  assert.match(account, /Sandbox payment/);
});

test('customer can submit verified-purchase product reviews after delivery', () => {
  assert.match(account, //customer\/products\//);
  assert.match(account, //reviews/);
  assert.match(account, /x\.status==='DELIVERED'/);
  assert.match(account, /reviewForms/);
});

test('storefront supports adding products to wishlist with login continuation', () => {
  assert.match(storefront, /data-wish/);
  assert.match(storefront, /customer\/wishlist/);
  assert.match(storefront, /account\.html\?wishlist=/);
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
