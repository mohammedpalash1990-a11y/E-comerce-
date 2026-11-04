import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const spec = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../apps/api/src/postgres-catalog-routes.mjs', import.meta.url), 'utf8');

function operation(path, method = 'get') {
  const start = spec.indexOf('  ' + path + ':');
  assert.notEqual(start, -1, 'Missing OpenAPI path ' + path);
  const next = spec.indexOf('\n  /', start + 1);
  const block = spec.slice(start, next < 0 ? spec.indexOf('\ncomponents:', start) : next);
  const methodStart = block.indexOf('\n    ' + method + ':');
  assert.notEqual(methodStart, -1, 'Missing ' + method.toUpperCase() + ' ' + path);
  const after = block.slice(methodStart + method.length + 7);
  const nextMethod = after.search(/\n    (get|post|put|patch|delete|options|head):/);
  return nextMethod < 0 ? after : after.slice(0, nextMethod);
}

test('all PostgreSQL public catalog routes are documented without bearer authentication', () => {
  const expected = [
    ["GET", "/api/v1/categories"],
    ["GET", "/api/v1/brands"],
    ["GET", "/api/v1/products"],
    ["GET", "/api/v1/products/suggest"],
    ["GET", "/api/v1/products/{id}"],
    ["GET", "/api/v1/products/{id}/reviews"]
  ];
  for (const [method, path] of expected) {
    assert.ok(routes.includes("route('" + method + "', '" + path.replace('{id}', ':id') + "', null,"), 'Route missing from implementation: ' + path);
    const op = operation(path, method.toLowerCase());
    assert.match(op, /summary:/);
    assert.match(op, /'200':/);
    assert.doesNotMatch(op, /security:/);
  }
});

test('catalog search documents all filters, sort allowlist and pagination caps', () => {
  const op = operation('/api/v1/products');
  for (const name of ['q', 'category', 'brand', 'min_price', 'max_price', 'sort', 'limit', 'offset']) {
    assert.ok(op.includes('name: ' + name), 'Missing parameter ' + name);
  }
  assert.ok(op.includes('maximum: 100'));
  assert.ok(op.includes('maximum: 10000'));
  assert.ok(op.includes('price_asc, price_desc, newest'));
});

test('catalog public response schemas are defined and omit private identifiers', () => {
  for (const name of ['Brand', 'CatalogSuggestion', 'CatalogProductListItem', 'CatalogProductDetail', 'ProductReview']) {
    assert.ok(spec.includes('    ' + name + ':\n'), 'Missing schema ' + name);
  }
  const detailStart = spec.indexOf('    CatalogProductDetail:\n');
  const reviewStart = spec.indexOf('    ProductReview:\n');
  const addressStart = spec.indexOf('    Address:\n');
  const detail = spec.slice(detailStart, reviewStart);
  const review = spec.slice(reviewStart, addressStart);
  assert.doesNotMatch(detail, /seller_id|password_hash|session_token|otp_code/);
  assert.doesNotMatch(review, /user_id|seller_id|session_token/);
});
