import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { startApi } from './helpers.mjs';

const api = await startApi(4429);
test.after(() => api.stop());

test('SQLite inventory workspace supports alerts, reports, idempotent adjustment requests, and admin approval', async () => {
  const sellerLogin = await api.login('01700000002', 'Seller@12345');
  assert.equal(sellerLogin.status, 200);
  const sellerToken = sellerLogin.data.token;

  const adminLogin = await api.login('01700000001', 'Admin@12345');
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.data.token;

  const custLogin = await api.login('01700000003', 'Customer@12345');
  assert.equal(custLogin.status, 200);
  const custToken = custLogin.data.token;

  // Role isolation
  const custDenied = await api.request('/api/v1/seller/inventory', { token: custToken });
  assert.equal(custDenied.status, 403);
  const sellerDenied = await api.request('/api/v1/admin/inventory/adjustments', { token: sellerToken });
  assert.equal(sellerDenied.status, 403);

  // Seller inventory & low stock
  const inv = await api.request('/api/v1/seller/inventory', { token: sellerToken });
  assert.equal(inv.status, 200);
  assert.ok(inv.data.data.length >= 5);
  const wallet = inv.data.data.find(p => p.name_en === 'Leather Wallet');
  assert.ok(wallet, 'expected seeded low-stock Leather Wallet');
  assert.equal(wallet.low_stock, true);
  const initialStock = wallet.stock;

  const alerts = await api.request('/api/v1/seller/inventory/alerts?threshold=5', { token: sellerToken });
  assert.equal(alerts.status, 200);
  assert.ok(alerts.data.data.some(p => p.id === wallet.id));

  // Validation: out-of-range delta rejected
  const badDelta = await api.request(`/api/v1/seller/inventory/${wallet.id}/adjust-requests`, {
    method: 'POST',
    token: sellerToken,
    body: { delta: 25, reason: 'Too large', idempotency_key: 'inv-key-bad-001' }
  });
  assert.equal(badDelta.status, 400);

  // Idempotent adjustment request
  const key = 'inv-req-wallet-001';
  const req1 = await api.request(`/api/v1/seller/inventory/${wallet.id}/adjust-requests`, {
    method: 'POST',
    token: sellerToken,
    body: { delta: 6, reason: 'Restock batch', idempotency_key: key }
  });
  assert.equal(req1.status, 201);
  assert.equal(req1.data.data.duplicate, false);
  const reqId = req1.data.data.id;

  const reqDup = await api.request(`/api/v1/seller/inventory/${wallet.id}/adjust-requests`, {
    method: 'POST',
    token: sellerToken,
    body: { delta: 6, reason: 'Restock batch', idempotency_key: key }
  });
  assert.equal(reqDup.status, 201);
  assert.equal(reqDup.data.data.duplicate, true);
  assert.equal(reqDup.data.data.id, reqId);

  // Admin lists & approves
  const pending = await api.request('/api/v1/admin/inventory/adjustments?status=PENDING', { token: adminToken });
  assert.equal(pending.status, 200);
  assert.ok(pending.data.data.some(r => r.id === reqId));

  const approve = await api.request(`/api/v1/admin/inventory/adjustments/${reqId}/decision`, {
    method: 'POST',
    token: adminToken,
    body: { decision: 'APPROVE', note: 'Verified invoice' }
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.data.status, 'APPROVED');
  assert.equal(approve.data.data.stock.before, initialStock);
  assert.equal(approve.data.data.stock.after, initialStock + 6);

  // Cannot decide twice
  const redecide = await api.request(`/api/v1/admin/inventory/adjustments/${reqId}/decision`, {
    method: 'POST',
    token: adminToken,
    body: { decision: 'REJECT', note: 'Late' }
  });
  assert.equal(redecide.status, 409);

  // Movement history and report reflect the approved adjustment
  const moves = await api.request(`/api/v1/seller/inventory/${wallet.id}/movements`, { token: sellerToken });
  assert.equal(moves.status, 200);
  assert.equal(moves.data.data.length, 1);
  assert.equal(moves.data.data[0].quantity_delta, 6);

  const report = await api.request('/api/v1/admin/inventory/report', { token: adminToken });
  assert.equal(report.status, 200);
  assert.ok(report.data.data.movement_count >= 1);
  assert.equal(report.data.data.units_added, 6);
});

test('all storefront and admin inline JavaScript parse cleanly without blocking dialogs', async () => {
  for (const file of ['apps/web/public/index.html', 'apps/web/public/account.html', 'apps/web/public/seller.html', 'apps/web/public/admin.html']) {
    const html = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.equal(/\b(?:alert|prompt)\s*\(/.test(html), false, file + ' should not use alert() or prompt()');
    const scripts = html.split('<script').slice(1).map(part => {
      const open = part.indexOf('>');
      const close = part.indexOf('</script>');
      return open >= 0 && close > open ? part.slice(open + 1, close).trim() : '';
    }).filter(Boolean);
    assert.ok(scripts.length > 0, 'expected inline script in ' + file);
    for (const script of scripts) new vm.Script(script, { filename: file + ':inline-script' });
  }
});
