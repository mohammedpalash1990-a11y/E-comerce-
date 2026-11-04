import { HttpError, bad } from './postgres-shared.mjs';
import { parseSafePostgresBigInt } from './postgres-types.mjs';

export const MAX_CART_ITEMS = 50;
const MAX_QUANTITY = 1000;
const LIVE = "p.active=1 AND p.status='ACTIVE' AND EXISTS(SELECT 1 FROM seller_profiles sp WHERE sp.user_id=p.seller_id AND sp.status='APPROVED')";

function productKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw bad('Product ID is required and must be at most 160 characters');
  }
  return value.trim();
}
function quantityValue(value) {
  // Preserve numeric form-input strings, but never coerce null/booleans/arrays
  // into zero: an invalid request must not silently delete a saved cart line.
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim())))) {
    throw bad('Quantity must be an integer between 0 and 1000');
  }
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
    throw bad('Quantity must be an integer between 0 and 1000');
  }
  return quantity;
}
function nonnegativeInteger(value) {
  const result = parseSafePostgresBigInt(value);
  if (result < 0) throw new RangeError('Cart data must contain nonnegative integers');
  return result;
}
function effectivePrice(row) {
  const price = nonnegativeInteger(row.price_paisa);
  const discount = row.discount_paisa == null ? null : nonnegativeInteger(row.discount_paisa);
  return discount !== null && discount > 0 && discount < price ? discount : price;
}

// Adapted from the cart domain in existing PR #6, isolated from its older
// checkout/runtime composition. Cart edits do not reserve inventory or fix prices.
export function createPostgresCartRepository(database) {
  if (!database?.q || !database?.tx) throw new TypeError('PostgreSQL database with transactions is required');
  const q = sql => database.q(sql);

  async function getCart(userId) {
    const rows = await q(`SELECT ci.product_id,ci.quantity,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,
        p.active,p.status,sp.status AS seller_status,
        (SELECT url FROM product_images i WHERE i.product_id=p.id ORDER BY position,i.id LIMIT 1) AS image
      FROM cart_items ci JOIN products p ON p.id=ci.product_id
      LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id
      WHERE ci.user_id=? ORDER BY ci.product_id`).all(userId);
    let subtotal = 0, itemCount = 0;
    const items = rows.map(row => {
      const quantity = nonnegativeInteger(row.quantity), stock = nonnegativeInteger(row.stock);
      if (quantity < 1) throw new RangeError('Stored cart quantity must be positive');
      const unit = effectivePrice(row), total = nonnegativeInteger(unit * quantity);
      subtotal = nonnegativeInteger(subtotal + total);
      itemCount = nonnegativeInteger(itemCount + quantity);
      return { product_id: row.product_id, name_bn: row.name_bn, name_en: row.name_en,
        quantity, stock, image: row.image || null, unit_price_paisa: unit, line_total_paisa: total,
        available: Number(row.active) === 1 && row.status === 'ACTIVE' && row.seller_status === 'APPROVED' && stock >= quantity };
    });
    return { items, subtotal_paisa: subtotal, item_count: itemCount };
  }

  const mutate = (userId, change) => database.tx(async () => {
    // Shared lock order with checkout: customer first, then product/cart rows.
    // Serializes same-customer edits, enforces the cap under concurrency, and
    // prevents a checkout from clearing an edit that arrived after its snapshot.
    const owner = await q("SELECT id FROM users WHERE id=? AND role='CUSTOMER' AND status='ACTIVE' FOR UPDATE").get(userId);
    if (!owner) throw new HttpError(401, 'Authentication required');
    await change();
    return getCart(userId);
  });

  async function setItemQuantity(userId, productId, quantity) {
    const key = productKey(productId), amount = quantityValue(quantity);
    if (amount === 0) return removeItem(userId, key);
    return mutate(userId, async () => {
      const product = await q(`SELECT p.stock FROM products p WHERE p.id=? AND ${LIVE} FOR SHARE OF p`).get(key);
      if (!product) throw new HttpError(404, 'Product not found');
      if (amount > nonnegativeInteger(product.stock)) throw new HttpError(409, 'Requested quantity exceeds available stock');
      const existing = await q('SELECT quantity FROM cart_items WHERE user_id=? AND product_id=?').get(userId, key);
      if (!existing) {
        const count = await q('SELECT COUNT(*) AS n FROM cart_items WHERE user_id=?').get(userId);
        if (nonnegativeInteger(count.n) >= MAX_CART_ITEMS) throw new HttpError(409, 'Cart can contain at most 50 different products');
      }
      await q('INSERT INTO cart_items(user_id,product_id,quantity) VALUES(?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity')
        .run(userId, key, amount);
    });
  }

  async function removeItem(userId, productId) {
    const key = productKey(productId);
    return mutate(userId, () => q('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(userId, key));
  }
  async function clearCart(userId) {
    return mutate(userId, () => q('DELETE FROM cart_items WHERE user_id=?').run(userId));
  }
  return Object.freeze({ getCart, setItemQuantity, removeItem, clearCart });
}
