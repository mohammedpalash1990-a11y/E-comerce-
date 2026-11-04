import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const spec = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../apps/api/src/postgres-catalog-routes.mjs', import.meta.url), 'utf8');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathBlock(path) {
  const match = spec.match(new RegExp('^  ' + escapeRegExp(path) + ':\\n([\\s\\S]*?)(?=^  /|^components:)', 'm'));
  assert.ok(match, 'OpenAPI must document ' + path);
  return match[1];
}

function operationBlock(path, method) {
  const block = pathBlock(path);
  const header = new RegExp('^    ' + method + ':\\n', 'm');
  const match = header.exec(block);
  assert.ok(match, 'OpenAPI must document ' + method.toUpperCase() + ' ' + path);
  const rest = block.slice(match.index + match[0].length);
  const nextOperation = rest.search(/^    (?:get|post|put|patch|delete|options|head):/m);
  return nextOperation < 0 ? rest : rest.slice(0, nextOperation);
}

function schemaBlock(name) {
  const schemasStart = spec.indexOf('  schemas:\\n');
  assert.notEqual(schemasStart, -1, 'OpenAPI schemas section must exist');
  const schemas = spec.slice(schemasStart);
  const header = new RegExp('^    ' + escapeRegExp(name) + ':\\n', 'm');
  const match = header.exec(schemas);
  assert.ok(match, 'OpenAPI must define schema ' + name);
  const rest = schemas.slice(match.index + match[0].length);
  const nextSchema = rest.search(/^    [A-Z][A-Za-z0-9_]*:/m);
  return nextSchema < 0 ? rest : rest.slice(0, nextSchema);
}

test('every PostgreSQL public catalog route has an unauthenticated OpenAPI operation', () => {
  const definitions = [...routes.matchAll(/route\\('([A-Z]+)', '([^']+)', null,/g)];
  assert.equal(definitions.length, 6, 'Expected the six public catalog routes to remain registered');

  for (const [, method, pattern] of definitions) {
    const path = pattern.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
    const operation = operationBlock(path, method.toLowerCase());
    assert.match(operation, /^      summary: .+/m, method + ' ' + path + ' needs a summary');
    assert.match(operation, /^        '200':/m, method + ' ' + path + ' needs a success response');
    assert.doesNotMatch(operation, /^      security:/m, method + ' ' + path + ' is public and must not require bearer auth');
  }
});

test('catalog search contract documents all supported filters and bounded pagination', () => {
  const operation = operationBlock('/api/v1/products', 'get');
  for (const name of ['q', 'category', 'brand', 'min_price', 'max_price', 'sort', 'limit', 'offset']) {
    assert.match(operation, new RegExp('^\\s+name: ' + name + '$', 'm'), 'Missing query parameter: ' + name);
  }
  assert.match(operation, /maximum: 100/);
  assert.match(operation, /maximum: 10000/);
  assert.match(operation, /enum: \\[price_asc, price_desc, newest\\]/);
});

test('catalog detail, autocomplete and reviews use explicit response schemas', () => {
  assert.match(operationBlock('/api/v1/products/{id}', 'get'), /CatalogProductDetail/);
  assert.match(operationBlock('/api/v1/products/{id}', 'get'), /^        '404':/m);
  assert.match(operationBlock('/api/v1/products/{id}/reviews', 'get'), /ProductReview/);
  assert.match(operationBlock('/api/v1/products/suggest', 'get'), /CatalogSuggestion/);
  assert.match(operationBlock('/api/v1/brands', 'get'), /Brand/);
});

test('public catalog schemas do not expose seller ownership or credential identifiers', () => {
  const detail = schemaBlock('CatalogProductDetail');
  const review = schemaBlock('ProductReview');
  assert.doesNotMatch(detail, /^\\s+(?:seller_id|password|password_hash|session_token|otp_code):/m);
  assert.doesNotMatch(review, /^\\s+(?:user_id|seller_id|password|session_token):/m);
});
