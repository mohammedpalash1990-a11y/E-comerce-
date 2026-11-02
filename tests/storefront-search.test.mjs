import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const scriptStart = html.indexOf('<script>');
const scriptEnd = html.indexOf('</script>', scriptStart);
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, 'storefront must contain its application script');
const script = html.slice(scriptStart + '<script>'.length, scriptEnd);

function extractFunction(name) {
  const start = script.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' must exist');
  const open = script.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < script.length; i++) {
    if (script[i] === '{') depth++;
    if (script[i] === '}') {
      depth--;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error('Could not extract ' + name);
}

const productStart = script.indexOf('const products=');
assert.notEqual(productStart, -1, 'baseline product catalogue must exist');
const arrayStart = script.indexOf('[', productStart);
let depth = 0;
let arrayEnd = -1;
for (let i = arrayStart; i < script.length; i++) {
  if (script[i] === '[' || script[i] === '{') depth++;
  if (script[i] === ']' || script[i] === '}') {
    depth--;
    if (depth === 0) { arrayEnd = i; break; }
  }
}
assert.notEqual(arrayEnd, -1, 'product catalogue must be balanced');
const productDecl = script.slice(productStart, arrayEnd + 2);
const normalizeFn = extractFunction('normalizeSearch');
const filterFn = extractFunction('getVisibleProducts');
const sandbox = {};
const executable = [productDecl, normalizeFn, filterFn, 'globalThis.api={products,normalizeSearch,getVisibleProducts};'].join(String.fromCharCode(10));
vm.runInNewContext(executable, sandbox);

test('renders all eight baseline catalogue products when search is empty', () => {
  assert.equal(sandbox.api.getVisibleProducts('', 'all').length, 8);
});

test('search matches Bengali product names', () => {
  const results = sandbox.api.getVisibleProducts('কটন', 'all');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'p2');
});

test('search matches English product names case-insensitively', () => {
  const results = sandbox.api.getVisibleProducts('WIRELESS EARBUDS', 'all');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'p1');
});

test('category and search filters compose without leaking other categories', () => {
  assert.equal(sandbox.api.getVisibleProducts('speaker', 'electronics').length, 1);
  assert.equal(sandbox.api.getVisibleProducts('speaker', 'fashion').length, 0);
});

test('normalizes repeated whitespace and Unicode compatibility forms', () => {
  assert.equal(sandbox.api.normalizeSearch('  Wireless   Earbuds  '), 'wireless earbuds');
  assert.equal(sandbox.api.normalizeSearch('ＦＵＬＬ'), 'full');
});

test('accessible result announcements and zero-result recovery are wired', () => {
  assert.ok(html.includes('id="resultCount" role="status" aria-live="polite" aria-atomic="true"'));
  assert.ok(script.includes("$('#resultCount').textContent=list.length+' টি পণ্য'"));
  assert.ok(script.includes('resetCatalog'));
  assert.ok(script.includes("e.key==='Escape'"));
  assert.ok(script.includes('aria-label='));
  assert.ok(script.includes('কার্টে যোগ করুন'));
});
