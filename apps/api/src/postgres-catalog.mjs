const LIVE = "p.active=1 AND p.status='ACTIVE' AND EXISTS(SELECT 1 FROM seller_profiles sp WHERE sp.user_id=p.seller_id AND sp.status='APPROVED')";
const PRICE = "CASE WHEN p.discount_paisa IS NOT NULL AND p.discount_paisa>0 AND p.discount_paisa<p.price_paisa THEN p.discount_paisa ELSE p.price_paisa END";

function safeInteger(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new TypeError(label + ' must be a safe integer');
  return n;
}

function productView(row) {
  const price = safeInteger(row.price_paisa, 'price_paisa');
  const discount = row.discount_paisa == null ? null : safeInteger(row.discount_paisa, 'discount_paisa');
  const stock = safeInteger(row.stock, 'stock');
  const sale = discount !== null && discount > 0 && discount < price ? discount : price;
  return {
    ...row,
    price_paisa: price,
    discount_paisa: discount,
    stock,
    price_bdt: price / 100,
    sale_price_bdt: sale / 100,
    discount_price_bdt: discount === null ? null : discount / 100,
    in_stock: stock > 0
  };
}

function readParam(params, key) {
  if (params && typeof params.get === 'function') return params.get(key);
  return params?.[key] ?? null;
}

function priceFilter(params, key, operator, clauses, values, { positiveOnly = false } = {}) {
  const raw = readParam(params, key);
  if (raw === null || raw === undefined || raw === '') return;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || (positiveOnly && amount <= 0)) return;
  const paisa = Math.round(amount * 100);
  if (!Number.isSafeInteger(paisa)) return;
  clauses.push(PRICE + operator + '?');
  values.push(paisa);
}

export function createPostgresCatalogRepository(database) {
  if (!database || typeof database.q !== 'function') {
    throw new TypeError('A PostgreSQL database adapter with q() is required');
  }

  const query = sql => database.q(sql);

  async function listCategories() {
    return query('SELECT slug,name_bn,name_en FROM categories ORDER BY name_bn').all();
  }

  async function listBrands() {
    return query('SELECT slug,name FROM brands ORDER BY name').all();
  }

  async function listProducts(params = new URLSearchParams()) {
    const term = String(readParam(params, 'q') ?? '').slice(0, 80);
    const where = [LIVE, '(p.name_bn ILIKE ? OR p.name_en ILIKE ?)'];
    const values = ['%' + term + '%', '%' + term + '%'];

    const category = readParam(params, 'category');
    if (category) {
      where.push('c.slug=?');
      values.push(String(category));
    }
    const brand = readParam(params, 'brand');
    if (brand) {
      where.push('b.slug=?');
      values.push(String(brand));
    }
    priceFilter(params, 'min_price', '>=', where, values);
    priceFilter(params, 'max_price', '<=', where, values, { positiveOnly: true });

    const sort = readParam(params, 'sort');
    const order = {
      price_asc: PRICE + ' ASC',
      price_desc: PRICE + ' DESC',
      newest: 'p.created_at DESC,p.id DESC'
    }[sort] || 'p.name_bn';

    const rawLimit = Number.parseInt(readParam(params, 'limit'), 10);
    const rawOffset = Number(readParam(params, 'offset'));
    const limit = Math.min(Math.max(rawLimit || 100, 1), 100);
    // Deep OFFSET scans become increasingly expensive; keep public catalog pagination bounded.
    const offset = Number.isSafeInteger(rawOffset) ? Math.min(Math.max(rawOffset, 0), 10000) : 0;

    const rows = await query(`SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,c.slug category_slug,b.name brand,
      (SELECT url FROM product_images i WHERE i.product_id=p.id ORDER BY position LIMIT 1) image
      FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, limit, offset);

    return rows.map(productView);
  }

  async function suggestProducts(params = new URLSearchParams()) {
    const term = String(readParam(params, 'q') ?? '').slice(0, 40);
    if (term.length < 1) return [];
    return query(`SELECT p.id,p.name_bn,p.name_en FROM products p
      WHERE ${LIVE} AND (p.name_bn ILIKE ? OR p.name_en ILIKE ?)
      ORDER BY p.name_bn LIMIT 8`).all('%' + term + '%', '%' + term + '%');
  }

  async function getProduct(productId) {
    const product = await query(`SELECT p.*,c.slug category_slug,b.name brand,sp.shop_name seller_shop
      FROM products p JOIN categories c ON c.id=p.category_id
      LEFT JOIN brands b ON b.id=p.brand_id
      LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id
      WHERE p.id=? AND ${LIVE}`).get(String(productId));

    if (!product) return null;

    const [ratingRows, imageRows] = await Promise.all([
      query('SELECT COALESCE(AVG(rating),0) a,COUNT(*) n FROM reviews WHERE product_id=?').all(product.id),
      query('SELECT url FROM product_images WHERE product_id=? ORDER BY position').all(product.id)
    ]);
    const rating = ratingRows[0] || { a: 0, n: 0 };
    const { seller_id, password, ...publicFields } = product;
    let variants = [];
    try {
      const parsed = JSON.parse(product.variants || '[]');
      if (Array.isArray(parsed)) variants = parsed;
    } catch { /* Keep malformed legacy variant data out of the public response. */ }

    return {
      ...productView(publicFields),
      variants,
      images: imageRows.map(image => image.url),
      rating: Math.round(Number(rating.a || 0) * 10) / 10,
      review_count: safeInteger(rating.n || 0, 'review_count')
    };
  }

  async function listReviews(productId) {
    return query(`SELECT r.rating,r.comment,r.created_at,u.name
      FROM reviews r JOIN users u ON u.id=r.user_id
      WHERE r.product_id=? ORDER BY r.created_at DESC LIMIT 50`).all(String(productId));
  }

  return Object.freeze({
    listCategories,
    listBrands,
    listProducts,
    suggestProducts,
    getProduct,
    listReviews
  });
}
