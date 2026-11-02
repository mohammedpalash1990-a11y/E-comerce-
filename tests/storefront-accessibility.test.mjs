import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('storefront exposes a keyboard skip link and a named search landmark', () => {
  assert.match(html, /class="skip-link" href="#main-content"/);
  assert.match(html, /<main class="wrap" id="main-content" tabindex="-1">/);
  assert.match(html, /<form class="search" id="searchForm" role="search">/);
  assert.match(html, /<label class="sr-only" for="search">/);
  assert.match(html, /aria-controls="grid"/);
});

test('category controls expose their selected state to assistive technology', () => {
  assert.match(html, /role="group" aria-label="পণ্য ক্যাটাগরি"/);
  assert.match(html, /aria-pressed=/);
  assert.match(html, /\\(id===active\\)/);
});

test('cart drawer is a labelled modal with live cart updates', () => {
  assert.match(html, /id="cartDialog" role="dialog" aria-modal="true" aria-labelledby="cartTitle"/);
  assert.match(html, /id="cartLines" aria-live="polite"/);
  assert.match(html, /id="cartCount" aria-live="polite"/);
  assert.match(html, /id="toast" role="status" aria-live="polite"/);
});

test('cart keyboard flow returns focus, closes on Escape and traps Tab', () => {
  assert.match(html, /function openCart\(\)[\s\S]*?returnFocus=document\.activeElement/);
  assert.match(html, /function closeCart\(\)[\s\S]*?returnFocus\.focus\(\)/);
  assert.match(html, /if\(e\.key==='Escape'\)\{closeCart\(\);return\}/);
  assert.match(html, /if\(e\.key==='Tab'\)/);
});

test('existing demo cart persistence and non-live-order guard remain intact', () => {
  assert.match(html, /localStorage\.getItem\('haat_cart_demo'/);
  assert.match(html, /localStorage\.setItem\('haat_cart_demo'/);
  assert.match(html, /এটি শুধু ডেমো—লাইভ অর্ডার এখনো চালু হয়নি/);
});
