import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresCatalogRepository } from '../apps/api/src/postgres-catalog.mjs';

function databaseWith(handler) {
  const calls = [];
  const pool = {
    async query(text, values = []) {
      calls.push({ text, values });
      return handler(text, values, calls.length);
    },
    async connect() { throw new Error('No transaction expected in catalog read tests'); }
  };
  return { database: createPostgresDatabase(pool), calls };
}

test('catalog listing applies approved-seller visibility, ILIKE search, bounded pagination and safe sort selection', async () => {
  const { database, calls } = databaseWith((sql, values) => ({
    rows: [{ id: 'p-1', name_bn: 'শার্ট', name_en: 'Shirt', price_paisa: '125000', discount_paisa: '99000', stock: '4', category_slug: 'fashion', brand: 'Demo', image: '/shirt.jpg' }],
    rowCount: 1
  }));
  const catalog = createPostgresCatalogRepository(database);
  const result = await catalog.listProducts(new URLSearchParams({
    q: 'shirt', category: 'fashion', brand: 'demo', min_price: '500', max_price: '1500',
    sort: 'price_asc; DROP TABLE products', limit: '1000', offset: '-2'
  }));

  assert.equal(result.length, 1);
  assert.equal(result[0].price_paisa, 125000);
  assert.equal(result[0].discount_paisa, 99000);
  assert.equal(result[0].stock, 4);
  assert.equal(result[0].price_bdt, 1250);
  assert.equal(result[0].sale_price_bdt, 990);
  assert.equal(result[0].in_stock, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /ILIKE/);
  assert.match(calls[0].text, /seller_profiles/);
  assert.match(calls[0].text, /ORDER BY p\.name_bn LIMIT \$7 OFFSET \$8/);
  assert.deepEqual(calls[0].values, ['%shirt%', '%shirt%', 'fashion', 'demo', 50000, 150000, 100, 0]);
  assert.doesNotMatch(calls[0].text, /DROP TABLE/);
});

test('catalog pagination caps deep offsets and rejects malformed offsets', async () => {
  const { database, calls } = databaseWith(() => ({ rows: [], rowCount: 0 }));
  const catalog = createPostgresCatalogRepository(database);

  await catalog.listProducts({ offset: '999999999999' });
  assert.equal(calls[0].values.at(-1), 10000);

  await catalog.listProducts({ offset: '12items' });
  assert.equal(calls[1].values.at(-1), 0);
});

test('catalog sorting uses explicit allowlisted expressions and newest order is stable', async () => {
  const { database, calls } = databaseWith(() => ({ rows: [], rowCount: 0 }));
  const catalog = createPostgresCatalogRepository(database);

  await catalog.listProducts({ sort: 'price_desc', limit: '10', offset: '20' });
  assert.match(calls[0].text, /ORDER BY CASE WHEN[\s\S]*? DESC LIMIT \$3 OFFSET \$4/);

  await catalog.listProducts({ sort: 'newest' });
  assert.match(calls[1].text, /ORDER BY p\.created_at DESC,p\.id DESC/);
});

test('empty suggestion query is short-circuited without a database round-trip', async () => {
  const { database, calls } = databaseWith(() => ({ rows: [], rowCount: 0 }));
  const catalog = createPostgresCatalogRepository(database);
  assert.deepEqual(await catalog.suggestProducts({ q: '' }), []);
  assert.equal(calls.length, 0);
});

test('suggestions and product detail preserve the public response shape and omit seller ownership identifiers', async () => {
  const { database, calls } = databaseWith(sql => {
    if (sql.includes('SELECT p.id,p.name_bn,p.name_en FROM products')) {
      return { rows: [{ id: 'p-1', name_bn: 'চা', name_en: 'Tea' }], rowCount: 1 };
    }
    if (sql.includes('SELECT p.*')) {
      return { rows: [{
        id: 'p-1', name_bn: 'চা', name_en: 'Tea', price_paisa: '20000', discount_paisa: null,
        stock: '0', seller_id: 'seller-secret', category_slug: 'grocery', brand: null,
        seller_shop: 'Tea House', variants: '[{"name":"Small"}]'
      }], rowCount: 1 };
    }
    if (sql.includes('AVG(rating)')) return { rows: [{ a: '4.5', n: '2' }], rowCount: 1 };
    if (sql.includes('SELECT url FROM product_images')) return { rows: [{ url: '/tea-1.jpg' }, { url: '/tea-2.jpg' }], rowCount: 2 };
    throw new Error('Unexpected SQL: ' + sql);
  });
  const catalog = createPostgresCatalogRepository(database);

  assert.deepEqual(await catalog.suggestProducts({ q: 'te' }), [{ id: 'p-1', name_bn: 'চা', name_en: 'Tea' }]);
  const detail = await catalog.getProduct('p-1');
  assert.equal(detail.sale_price_bdt, 200);
  assert.equal(detail.in_stock, false);
  assert.equal(detail.seller_shop, 'Tea House');
  assert.equal(detail.rating, 4.5);
  assert.equal(detail.review_count, 2);
  assert.deepEqual(detail.images, ['/tea-1.jpg', '/tea-2.jpg']);
  assert.deepEqual(detail.variants, [{ name: 'Small' }]);
  assert.equal('seller_id' in detail, false);
  assert.equal(calls.length, 4);
});

test('unknown product returns null without querying reviews or images', async () => {
  const { database, calls } = databaseWith(() => ({ rows: [], rowCount: 0 }));
  const catalog = createPostgresCatalogRepository(database);
  assert.equal(await catalog.getProduct('missing'), null);
  assert.equal(calls.length, 1);
});

test('catalog rejects unsafe PostgreSQL BIGINT values rather than silently rounding money or stock', async () => {
  const { database } = databaseWith(() => ({
    rows: [{ id: 'p-1', name_bn: 'x', name_en: 'x', price_paisa: '9007199254740992', discount_paisa: null, stock: '1' }],
    rowCount: 1
  }));
  const catalog = createPostgresCatalogRepository(database);
  await assert.rejects(catalog.listProducts(), /safe integer/);
});

test('catalog constructor requires the async database adapter contract', () => {
  assert.throws(() => createPostgresCatalogRepository({}), /q\(\)/);
});
