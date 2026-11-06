import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const seller = await readFile(new URL('../apps/web/public/seller.html', import.meta.url), 'utf8');

test('seller order cards render customer, delivery, line items and shipment tracking data', () => {
  for (const field of ['customer?.name', 'customer?.phone', 'delivery?.address', 'items||[]', 'shipment.tracking_id']) {
    assert.ok(seller.includes(field), 'seller order card is missing ' + field);
  }
  assert.ok(seller.includes('/seller/orders'));
  assert.ok(seller.includes('/seller/shipments/'));
});

test('seller courier controls are clearly sandbox-only and support each provider', () => {
  for (const provider of ['PATHAO', 'REDX', 'STEADFAST']) assert.ok(seller.includes('value="' + provider + '"'));
  assert.ok(seller.includes('Sandbox কুরিয়ার বুক করুন'));
  assert.ok(seller.includes('বাস্তব courier booking নয়'));
  assert.ok(seller.includes('/seller/courier/quote?area='));
  assert.ok(seller.includes("'/courier',{")));
});

test('seller shipment workflow exposes only forward status actions', () => {
  for (const status of ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED_DELIVERY', 'RETURNED']) {
    assert.ok(seller.includes("['" + status + "'"), 'missing courier transition ' + status);
  }
  assert.ok(seller.includes('data-courier-status'));
  assert.ok(seller.includes('data-book-courier'));
});

test('seller portal inline JavaScript parses without syntax errors', () => {
  const scripts = seller.split('<script').slice(1).map(part => {
    const open = part.indexOf('>');
    const close = part.indexOf('</script>');
    return open >= 0 && close > open ? part.slice(open + 1, close).trim() : '';
  }).filter(Boolean);
  assert.ok(scripts.length > 0);
  for (const script of scripts) new vm.Script(script, { filename: 'seller.html:inline-script' });
});
