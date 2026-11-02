import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDatabase } from '../apps/api/src/postgres-runtime.mjs';
import { createPostgresCatalogRepository } from '../apps/api/src/postgres-catalog.mjs';
import registerPublic from '../apps/api/src/routes_public.mjs';

function createCatalogRouteHarness(poolHandler) {
  const routes = [];
  const route = (method, pattern, roles, handler) => {
    const re = new RegExp('^' + pattern.replace(/:id/g, '([^/]+)').replace(/:(\w+)/g, '([^/]+)') + '$');
    routes.push({ method, re, handler });
  };
  const ok = (data, status = 200) => ({ status, body: { data } });

  const calls = [];
  const pool = {
    async query(text, values = []) {
      calls.push({ text, values });
      return poolHandler(text, values, calls.length);
    },
    async connect() {
      throw new Error('connect() not expected in catalog read routing');
    }
  };

  const postgresDatabase = createPostgresDatabase(pool);
  const catalogRepository = createPostgresCatalogRepository(postgresDatabase);
  registerPublic(route, ok, { catalogRepository });

  async function dispatch(method, pathAndQuery) {
    const url = new URL(pathAndQuery, 'http://localhost');
    const matched = routes.find(r => r.method === method && r.re.test(url.pathname));
    if (!matched) return { status: 404, body: { error: 'Not found' } };
    const m = url.pathname.match(matched.re);
    try {
      const out = await matched.handler({ url, params: m.slice(1) });
      return { status: out.status || 200, body: out.body };
    } catch (err) {
      return { status: err.status || 500, body: { error: err.message } };
    }
  }

  return { dispatch, calls };
}

test('HTTP catalog route /api/v1/categories queries PostgreSQL repository', async () => {
  const { dispatch, calls } = createCatalogRouteHarness(sql => {
    assert.match(sql, /FROM categories ORDER BY name_bn/);
    return {
      rows: [
        { slug: 'electronics', name_bn: 'ইলেকট্রনিক্স', name_en: 'Electronics' },
        { slug: 'fashion', name_bn: 'পোশাক', name_en: 'Fashion' }
      ],
      rowCount: 2
    };
  });

  const res = await dispatch('GET', '/api/v1/categories');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  assert.equal(res.body.data[0].slug, 'electronics');
  assert.equal(calls.length, 1);
});

test('HTTP catalog route /api/v1/brands queries PostgreSQL repository', async () => {
  const { dispatch, calls } = createCatalogRouteHarness(sql => {
    assert.match(sql, /FROM brands ORDER BY name/);
    return {
      rows: [
        { slug: 'aarong', name: 'Aarong' },
        { slug: 'walton', name: 'Walton' }
      ],
      rowCount: 2
    };
  });

  const res = await dispatch('GET', '/api/v1/brands');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  assert.equal(res.body.data[1].slug, 'walton');
  assert.equal(calls.length, 1);
});

test('HTTP catalog route /api/v1/products handles search, filters, pagination and sorting', async () => {
  const { dispatch, calls } = createCatalogRouteHarness((sql, values) => {
    assert.match(sql, /p\.name_bn ILIKE \$1/);
    assert.match(sql, /c\.slug=\$3/);
    assert.match(sql, /b\.slug=\$4/);
    assert.match(sql, />=\$5/);
    assert.match(sql, /<=\$6/);
    assert.match(sql, /ORDER BY CASE WHEN[\s\S]*? DESC LIMIT \$7 OFFSET \$8/);
    return {
      rows: [
        {
          id: 'prod-100',
          name_bn: 'স্মার্টফোন',
          name_en: 'Smartphone',
          price_paisa: '2500000',
          discount_paisa: '2200000',
          stock: '15',
          category_slug: 'electronics',
          brand: 'Walton',
          image: '/phone.png'
        }
      ],
      rowCount: 1
    };
  });

  const res = await dispatch(
    'GET',
    '/api/v1/products?q=smart&category=electronics&brand=walton&min_price=10000&max_price=30000&sort=price_desc&limit=25&offset=5'
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  const p = res.body.data[0];
  assert.equal(p.id, 'prod-100');
  assert.equal(p.price_bdt, 25000);
  assert.equal(p.sale_price_bdt, 22000);
  assert.equal(p.discount_price_bdt, 22000);
  assert.equal(p.in_stock, true);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [
    '%smart%',
    '%smart%',
    'electronics',
    'walton',
    1000000,
    3000000,
    25,
    5
  ]);
});

test('HTTP catalog route /api/v1/products/suggest short-circuits empty queries and returns suggestions', async () => {
  let queryCount = 0;
  const { dispatch, calls } = createCatalogRouteHarness((sql, values) => {
    queryCount++;
    assert.match(sql, /LIMIT 8/);
    return {
      rows: [
        { id: 'prod-1', name_bn: 'আম', name_en: 'Mango' }
      ],
      rowCount: 1
    };
  });

  const emptyRes = await dispatch('GET', '/api/v1/products/suggest');
  assert.equal(emptyRes.status, 200);
  assert.deepEqual(emptyRes.body.data, []);
  assert.equal(calls.length, 0);

  const matchedRes = await dispatch('GET', '/api/v1/products/suggest?q=man');
  assert.equal(matchedRes.status, 200);
  assert.equal(matchedRes.body.data.length, 1);
  assert.equal(matchedRes.body.data[0].name_en, 'Mango');
  assert.equal(calls.length, 1);
});

test('HTTP catalog route /api/v1/products/:id returns 404 for missing and full details for found product', async () => {
  const { dispatch, calls } = createCatalogRouteHarness((sql, values) => {
    if (sql.includes('WHERE p.id=$1')) {
      if (values[0] === 'missing-product-id') {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            id: 'found-prod-id',
            name_bn: 'চা পাতা',
            name_en: 'Tea Leaf',
            price_paisa: '35000',
            discount_paisa: null,
            stock: '50',
            seller_id: 'secret-seller-uuid',
            category_slug: 'grocery',
            brand: 'Ispahani',
            seller_shop: 'Sylhet Tea Estate',
            variants: JSON.stringify([{ name: '200g', price_bdt: 350 }])
          }
        ],
        rowCount: 1
      };
    }
    if (sql.includes('AVG(rating)')) {
      return { rows: [{ a: '4.8', n: '12' }], rowCount: 1 };
    }
    if (sql.includes('SELECT url FROM product_images')) {
      return { rows: [{ url: '/tea-front.jpg' }, { url: '/tea-back.jpg' }], rowCount: 2 };
    }
    throw new Error('Unexpected query: ' + sql);
  });

  const notFound = await dispatch('GET', '/api/v1/products/missing-product-id');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error, 'Product not found');

  const found = await dispatch('GET', '/api/v1/products/found-prod-id');
  assert.equal(found.status, 200);
  const data = found.body.data;
  assert.equal(data.id, 'found-prod-id');
  assert.equal(data.name_bn, 'চা পাতা');
  assert.equal(data.price_bdt, 350);
  assert.equal(data.sale_price_bdt, 350);
  assert.equal(data.rating, 4.8);
  assert.equal(data.review_count, 12);
  assert.deepEqual(data.images, ['/tea-front.jpg', '/tea-back.jpg']);
  assert.deepEqual(data.variants, [{ name: '200g', price_bdt: 350 }]);
  assert.equal(data.seller_shop, 'Sylhet Tea Estate');
  assert.equal('seller_id' in data, false);
});

test('HTTP catalog route /api/v1/products/:id/reviews returns reviews for product', async () => {
  const { dispatch, calls } = createCatalogRouteHarness((sql, values) => {
    assert.match(sql, /FROM reviews r JOIN users u ON u\.id=r\.user_id/);
    assert.equal(values[0], 'prod-reviews-test');
    return {
      rows: [
        { rating: '5', comment: 'দারুণ চা!', created_at: '2026-11-01T10:00:00Z', name: 'Rahim' },
        { rating: '4', comment: 'ভালো মান', created_at: '2026-11-01T09:00:00Z', name: 'Karim' }
      ],
      rowCount: 2
    };
  });

  const res = await dispatch('GET', '/api/v1/products/prod-reviews-test/reviews');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  assert.equal(res.body.data[0].comment, 'দারুণ চা!');
  assert.equal(res.body.data[0].name, 'Rahim');
  assert.equal(calls.length, 1);
});
