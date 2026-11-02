import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('storefront search and cart controls have accessible names and relationships', () => {
  assert.match(html, /<input id="search"[^>]*aria-label="পণ্য খুঁজুন"/);
  assert.match(html, /id="openCart"[^>]*aria-haspopup="dialog"[^>]*aria-controls="drawer"/);
  assert.match(html, /id="cartCount" aria-live="polite"/);
  assert.match(html, /id="resultCount" aria-live="polite"/);
  assert.match(html, /id="toast" role="status" aria-live="polite"/);
});

test('cart drawer exposes modal semantics and an explicitly labelled close control', () => {
  assert.match(html, /id="drawer" aria-hidden="true"><aside class="cart" role="dialog" aria-modal="true" aria-labelledby="cartTitle"/);
  assert.match(html, /id="closeCart" type="button" aria-label="কার্ট বন্ধ করুন"/);
  assert.match(html, /id="cartTitle">আপনার কার্ট<\/h2>/);
});

test('category and product actions expose state and product-specific names', () => {
  assert.match(html, /data-cat="\'+id\+'" aria-pressed=/);
  assert.match(html, /data-add="\'+p.id\+'" aria-label="\'+p.bn\+' কার্টে যোগ করুন"/);
});

test('cart dialog supports Escape, focus return and keyboard focus containment', () => {
  assert.match(html, /function openCart\(\)[\s\S]*?\$\('#closeCart'\)\.focus\(\)/);
  assert.match(html, /function closeCart\(\)[\s\S]*?\$\('#openCart'\)\.focus\(\)/);
  assert.match(html, /e\.key==='Escape'[\s\S]*?closeCart\(\)/);
  assert.match(html, /e\.key==='Tab'[\s\S]*?first\.focus\(\)/);
});
