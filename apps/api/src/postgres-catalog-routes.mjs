import { HttpError } from './postgres-shared.mjs';
import { createPostgresCatalogRepository } from './postgres-catalog.mjs';

function parsePositiveInt(val, fallback) {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number.parseInt(val, 10);
  return Number.isSafeInteger(n) ? n : fallback;
}

// PostgreSQL-only catalog HTTP routes.
// Isolated from SQLite core and checkout/commerce modules; mount only in the PostgreSQL API runtime.
export function registerPostgresCatalogRoutes(route, ok, options = {}) {
  const { database } = options;
  let catalog = options.catalogRepository;

  if (!catalog) {
    if (!database?.q) {
      throw new TypeError('PostgreSQL database or catalogRepository is required');
    }
    catalog = createPostgresCatalogRepository(database);
  }

  route('GET', '/api/v1/categories', null, async () => {
    return ok(await catalog.listCategories());
  });

  route('GET', '/api/v1/brands', null, async () => {
    return ok(await catalog.listBrands());
  });

  route('GET', '/api/v1/products', null, async ({ url }) => {
    const params = url ? url.searchParams : new URLSearchParams();
    const sanitizedParams = new URLSearchParams();

    const q = params.get('q');
    if (q) sanitizedParams.set('q', q.slice(0, 80));

    const category = params.get('category');
    if (category) sanitizedParams.set('category', category.slice(0, 100));

    const brand = params.get('brand');
    if (brand) sanitizedParams.set('brand', brand.slice(0, 100));

    const minPrice = params.get('min_price');
    if (minPrice !== null && minPrice !== '') {
      const n = Number(minPrice);
      if (Number.isFinite(n) && n >= 0) sanitizedParams.set('min_price', String(n));
    }

    const maxPrice = params.get('max_price');
    if (maxPrice !== null && maxPrice !== '') {
      const n = Number(maxPrice);
      if (Number.isFinite(n) && n > 0) sanitizedParams.set('max_price', String(n));
    }

    const sort = params.get('sort');
    if (sort && ['price_asc', 'price_desc', 'newest'].includes(sort)) {
      sanitizedParams.set('sort', sort);
    }

    const limit = Math.min(Math.max(parsePositiveInt(params.get('limit'), 100), 1), 100);
    sanitizedParams.set('limit', String(limit));

    const offset = Math.max(parsePositiveInt(params.get('offset'), 0), 0);
    sanitizedParams.set('offset', String(offset));

    const products = await catalog.listProducts(sanitizedParams);
    return ok(products);
  });

  route('GET', '/api/v1/products/suggest', null, async ({ url }) => {
    const params = url ? url.searchParams : new URLSearchParams();
    const sanitizedParams = new URLSearchParams();
    const q = params.get('q');
    if (q) sanitizedParams.set('q', q.slice(0, 40));
    return ok(await catalog.suggestProducts(sanitizedParams));
  });

  route('GET', '/api/v1/products/:id', null, async ({ params }) => {
    const productId = params?.[0];
    if (!productId) throw new HttpError(400, 'Product id is required');
    const product = await catalog.getProduct(productId);
    if (!product) throw new HttpError(404, 'Product not found');
    return ok(product);
  });

  route('GET', '/api/v1/products/:id/reviews', null, async ({ params }) => {
    const productId = params?.[0];
    if (!productId) throw new HttpError(400, 'Product id is required');
    return ok(await catalog.listReviews(productId));
  });

  return Object.freeze({ catalog });
}
