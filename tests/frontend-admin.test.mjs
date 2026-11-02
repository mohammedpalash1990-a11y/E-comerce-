import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const admin = await readFile(new URL('../apps/web/public/admin.html', import.meta.url), 'utf8');

test('admin logout revokes the server session before clearing the local token', () => {
  assert.ok(admin.includes("call('/auth/logout'"));
  assert.ok(admin.includes("localStorage.removeItem('haat_admin_token')"));
});

test('admin console exposes customer search, account controls and order history', () => {
  for (const id of ['customerQuery','customerRows','customerDetail','customerSearchBtn']) assert.match(admin, new RegExp('id="'+id+'"'));
  for (const path of ['/admin/customers','/orders']) assert.ok(admin.includes(path));
  assert.match(admin, /data-customer-toggle/);
});

test('admin console exposes refund and payout moderation actions', () => {
  for (const path of ['/admin/refunds','/admin/payouts']) assert.ok(admin.includes(path));
  for (const id of ['refundRows','payoutRows','refreshRefunds','refreshPayouts']) assert.match(admin, new RegExp('id="'+id+'"'));
  assert.match(admin, /data-refund/);
  assert.match(admin, /data-payout/);
});

test('admin console exposes coupon management, finance reports and audit history', () => {
  for (const path of ['/admin/coupons','/admin/finance/summary','/admin/finance/report','/admin/audit-logs']) assert.ok(admin.includes(path));
  for (const id of ['couponForm','couponRows','financeStats','reportRows','auditRows']) assert.match(admin, new RegExp('id="'+id+'"'));
});

test('admin inline JavaScript parses without syntax errors', () => {
  const scripts = admin.split('<script').slice(1).map(part => {
    const open = part.indexOf('>');
    const close = part.indexOf('</script>');
    return open >= 0 && close > open ? part.slice(open + 1, close).trim() : '';
  }).filter(Boolean);
  assert.ok(scripts.length > 0);
  for (const script of scripts) new vm.Script(script, { filename: 'admin.html:inline-script' });
});
