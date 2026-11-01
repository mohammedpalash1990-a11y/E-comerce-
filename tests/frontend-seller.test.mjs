import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const seller = await readFile(new URL('../apps/web/public/seller.html', import.meta.url), 'utf8');

test('seller workspace exposes product create, edit, stock and archive workflows', () => {
  for (const id of ['productForm','productRows','refreshProducts','cancelEdit']) assert.match(seller, new RegExp('id="'+id+'"'));
  for (const path of ['/seller/products','/stock']) assert.ok(seller.includes(path), 'missing seller product API path '+path);
  assert.match(seller, /method:id\?'PUT':'POST'/);
  assert.match(seller, /method:'PATCH'/);
  assert.match(seller, /method:'DELETE'/);
});

test('seller workspace exposes order transitions and sandbox courier booking', () => {
  for (const path of ['/seller/orders','/courier']) assert.ok(seller.includes(path), 'missing seller order API path '+path);
  for (const provider of ['PATHAO','STEADFAST','REDX']) assert.ok(seller.includes(provider));
  assert.match(seller, /data-status/);
  assert.match(seller, /tracking_id/);
});

test('seller workspace exposes finance, payout request and history', () => {
  for (const path of ['/seller/finance','/seller/payouts']) assert.ok(seller.includes(path), 'missing finance API path '+path);
  for (const field of ['available_balance_bdt','pending_balance_bdt','net_earnings_bdt','paid_out_bdt']) assert.ok(seller.includes(field));
  assert.match(seller, /name="amount_bdt"/);
  assert.match(seller, /name="account"/);
});

test('seller inline JavaScript parses without syntax errors', () => {
  const scripts = seller.split('<script').slice(1).map(part => {
    const open = part.indexOf('>');
    const close = part.indexOf('</script>');
    return open >= 0 && close > open ? part.slice(open + 1, close).trim() : '';
  }).filter(Boolean);
  assert.ok(scripts.length > 0);
  for (const script of scripts) new vm.Script(script, { filename: 'seller.html:inline-script' });
});
