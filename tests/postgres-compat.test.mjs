import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = [
  'routes_public.mjs',
  'routes_customer.mjs',
  'routes_seller.mjs',
  'routes_admin.mjs',
  'routes_payments.mjs',
  'orders.mjs'
];

test('route SQL avoids SQLite rowid and INSERT OR IGNORE syntax', async () => {
  for (const file of files) {
    const source = await readFile(new URL('../apps/api/src/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\browid\b/i, file + ' must use stable primary-key ordering');
    assert.doesNotMatch(source, /INSERT\s+OR\s+IGNORE/i, file + ' must use ON CONFLICT');
  }
});

test('catalog price filter uses a portable CASE expression', async () => {
  const source = await readFile(new URL('../apps/api/src/routes_public.mjs', import.meta.url), 'utf8');
  assert.match(source, /const eff = 'CASE WHEN p\.discount_paisa IS NOT NULL/);
  assert.doesNotMatch(source, /MIN\(p\.discount_paisa,p\.price_paisa\)/);
});

test('initial marketplace categories are reproducibly seeded by an idempotent migration', async () => {
  const sql = await readFile(new URL('../apps/api/migrations/postgres/003_seed_categories.sql', import.meta.url), 'utf8');
  assert.match(sql, /INSERT INTO categories/);
  assert.match(sql, /ON CONFLICT\(slug\) DO UPDATE/);
  for (const slug of ['electronics', 'fashion', 'home', 'beauty', 'grocery', 'kids', 'sports', 'books']) {
    assert.ok(sql.includes("'" + slug + "'"), 'missing category ' + slug);
  }
});
