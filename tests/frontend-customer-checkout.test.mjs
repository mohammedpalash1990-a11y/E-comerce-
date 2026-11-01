import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const account = await readFile(new URL('../apps/web/public/account.html', import.meta.url), 'utf8');
const storefront = await readFile(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');

test('customer forms access reserved name and id controls through form elements', () => {
  assert.ok(account.includes("elements.namedItem('name').value"));
  assert.ok(account.includes("elements.namedItem('id').value"));
  assert.ok(!account.includes('f.name.value'));
  assert.ok(!account.includes('f.id.value'));
});

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

test('storefront checkout transfers its local cart into the account checkout flow', () => {
  assert.ok(storefront.includes('account.html?checkout=1'));
  assert.ok(!storefront.includes('const name=prompt('));
  assert.ok(!storefront.includes('const password=prompt('));
  assert.ok(account.includes('syncStorefrontCart'));
  assert.ok(account.includes("localStorage.getItem('haat_cart_v1')"));
  assert.ok(account.includes("request('/customer/cart'"));
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


test('storefront cart sync clears local cart only after successful server writes', async () => {
  const match = account.match(/async function syncStorefrontCart\(\)\{[\s\S]*?\nasync function enter\(/);
  assert.ok(match, 'syncStorefrontCart implementation should be present');
  const source = match[0].replace(/\nasync function enter\($/, '');
  const storage = new Map([['haat_cart_v1', JSON.stringify({ product_a: 2, product_b: 1 })]]);
  const calls = [];
  const context = {
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: {} };
    }
  };
  const sync = vm.runInNewContext('(' + source + ')', context);
  const errors = await sync();
  assert.deepEqual(errors, []);
  assert.equal(storage.has('haat_cart_v1'), false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(x => JSON.parse(x.options.body)), [
    { productId: 'product_a', quantity: 2 },
    { productId: 'product_b', quantity: 1 }
  ]);
});

test('storefront cart sync retains only items whose server write failed', async () => {
  const match = account.match(/async function syncStorefrontCart\(\)\{[\s\S]*?\nasync function enter\(/);
  assert.ok(match);
  const source = match[0].replace(/\nasync function enter\($/, '');
  const storage = new Map([['haat_cart_v1', JSON.stringify({ good: 3, unavailable: 2 })]]);
  const context = {
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    request: async (_path, options) => {
      const body = JSON.parse(options.body);
      if (body.productId === 'unavailable') throw new Error('স্টকে যথেষ্ট পণ্য নেই');
      return { data: {} };
    }
  };
  const sync = vm.runInNewContext('(' + source + ')', context);
  const errors = await sync();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /স্টকে যথেষ্ট পণ্য নেই/);
  assert.deepEqual(JSON.parse(storage.get('haat_cart_v1')), { unavailable: 2 });
});

test('storefront cart sync rejects malformed data and invalid quantities without deleting them', async () => {
  const match = account.match(/async function syncStorefrontCart\(\)\{[\s\S]*?\nasync function enter\(/);
  assert.ok(match);
  const source = match[0].replace(/\nasync function enter\($/, '');
  for (const raw of ['{broken', JSON.stringify({ invalid: 0, fractional: 1.5, excessive: 1001 })]) {
    const storage = new Map([['haat_cart_v1', raw]]);
    let requestCount = 0;
    const sync = vm.runInNewContext('(' + source + ')', {
      localStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key)
      },
      request: async () => { requestCount++; return {}; }
    });
    const errors = await sync();
    assert.ok(errors.length > 0);
    assert.equal(requestCount, 0);
    assert.equal(storage.get('haat_cart_v1'), raw);
  }
});
