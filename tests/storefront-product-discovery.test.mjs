import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('catalogue exposes an accessible sorting control with stable default order', () => {
  assert.match(html, /id="sortProducts" aria-label="পণ্য সাজানোর ধরন"/);
  assert.match(html, /value="price-asc"/);
  assert.match(html, /value="price-desc"/);
  assert.match(html, /value="stock-desc"/);
  assert.match(html, /let active='all',sortBy='featured'/);
});

test('price and stock sorting operate on a filtered copy, not the source catalogue', () => {
  assert.match(html, /function getVisibleProducts\(searchValue,category='all',sort='featured'\)/);
  assert.match(html, /if\(sort==='price-asc'\)list\.sort\(\(a,b\)=>a\.price-b\.price\)/);
  assert.match(html, /if\(sort==='price-desc'\)list\.sort\(\(a,b\)=>b\.price-a\.price\)/);
  assert.match(html, /if\(sort==='stock-desc'\)list\.sort\(\(a,b\)=>b\.stock-a\.stock\)/);
});

test('every product card offers a product-specific details action', () => {
  assert.ok(html.includes("data-detail=\"'+p.id+'\""));
  assert.ok(html.includes("aria-label=\"'+p.bn+' বিস্তারিত দেখুন\""));
  assert.match(html, /function openProduct\(id\)/);
  assert.match(html, /productDescriptions/);
});

test('product details are presented in a labelled modal with focus management', () => {
  assert.match(html, /id="productDialog" role="dialog" aria-modal="true" aria-labelledby="productDialogTitle"/);
  assert.match(html, /productReturnFocus=document\.activeElement/);
  assert.match(html, /function closeProduct\(\)[\s\S]*?productReturnFocus\.focus\(\)/);
  assert.match(html, /if\(!\$\('#productModal'\)\.hidden\)[\s\S]*?if\(e\.key==='Escape'\)\{closeProduct\(\)/);
  assert.match(html, /if\(e\.key==='Tab'\)[\s\S]*?\$\('#productDialog'\)/);
});

test('adding from product details uses the existing persistent demo cart', () => {
  assert.match(html, /data-detail-add/);
  assert.match(html, /cart\[b\.dataset\.detailAdd\]=\(cart\[b\.dataset\.detailAdd\]\|\|0\)\+1/);
  assert.match(html, /localStorage\.setItem\('haat_cart_demo'/);
  assert.match(html, /এটি বর্তমানে একটি প্রকাশ্য frontend preview/);
  assert.match(html, /এটি শুধু ডেমো—লাইভ অর্ডার এখনো চালু হয়নি/);
});

test('product detail layout adapts to narrow screens', () => {
  assert.match(html, /@media\(max-width:560px\)\{\.product-modal/);
  assert.match(html, /\.product-detail-layout\{grid-template-columns:1fr/);
});
