import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = 4417;
const base = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, ['apps/api/src/server.mjs'], {
  env: { ...process.env, PORT: String(port), SQLITE_FILE: ':memory:' },
  stdio: 'ignore'
});
async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
}
test('catalog, seller product submission and admin moderation work with role checks', async t => {
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(base + '/health');
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.equal(ready, true, 'API should start');
  assert.equal((await request('/api/v1/categories')).status, 200);
  const initialCatalog = await request('/api/v1/products');
  assert.equal(initialCatalog.status, 200);
  assert.ok(initialCatalog.data.data.length >= 3);

  const sellerLogin = await request('/api/v1/auth/login', {
    method: 'POST', body: { phone: '01700000002', password: 'Seller@12345' }
  });
  assert.equal(sellerLogin.status, 200);
  const sellerToken = sellerLogin.data.token;
  const created = await request('/api/v1/seller/products', {
    method: 'POST', token: sellerToken,
    body: { name_bn: 'নতুন ব্যাগ', name_en: 'New Bag', category_slug: 'fashion', price_bdt: 850, stock: 7 }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.data.status, 'PENDING_REVIEW');

  const sellerProducts = await request('/api/v1/seller/products', { token: sellerToken });
  assert.equal(sellerProducts.status, 200);
  assert.ok(sellerProducts.data.data.some(product => product.id === created.data.data.id));
  const beforeApproval = await request('/api/v1/products?q=New%20Bag');
  assert.equal(beforeApproval.data.data.length, 0);

  const adminLogin = await request('/api/v1/auth/login', {
    method: 'POST', body: { phone: '01700000001', password: 'Admin@12345' }
  });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.data.token;
  const forbidden = await request('/api/v1/admin/products/pending', { token: sellerToken });
  assert.equal(forbidden.status, 403);
  const pending = await request('/api/v1/admin/products/pending', { token: adminToken });
  assert.ok(pending.data.data.some(product => product.id === created.data.data.id));

  const approved = await request('/api/v1/admin/products/' + created.data.data.id + '/approve', {
    method: 'POST', token: adminToken
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.data.status, 'ACTIVE');
  const afterApproval = await request('/api/v1/products?q=New%20Bag');
  assert.equal(afterApproval.data.data.length, 1);
  assert.equal(afterApproval.data.data[0].price_bdt, 850);

  const customerLogin = await request('/api/v1/auth/login', {
    method: 'POST', body: { phone: '01700000003', password: 'Customer@12345' }
  });
  assert.equal(customerLogin.status, 200);
  const checkout = await request('/api/v1/checkout', {
    method: 'POST', token: customerLogin.data.token,
    body: { items: [{ productId: created.data.data.id, quantity: 2 }] }
  });
  assert.equal(checkout.status, 201);
  assert.equal(checkout.data.data.total_bdt, 1700);
});
