import { bad, HttpError, id as defaultId, now as defaultNow, text } from './postgres-shared.mjs';

const MAX_IMMEDIATE_DELTA = 20;
const MAX_STOCK = 1000000;

function safeStock(value) {
  const stock = Number(value);
  if (!Number.isSafeInteger(stock) || stock < 0 || stock > MAX_STOCK) {
    throw new Error('Invalid product stock value');
  }
  return stock;
}

function validateAdjustment(input = {}) {
  const delta = Number(input.delta);
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_IMMEDIATE_DELTA) {
    throw bad('একবারে সর্বোচ্চ ২০টি স্টক যোগ বা কমানো যাবে');
  }
  const reason = text(input.reason, 300, 'কারণ');
  const key = String(input.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
    throw bad('সঠিক idempotency key দিতে হবে');
  }
  return { delta, reason, key };
}

// Seller inventory repository. All stock mutations, immutable movement records,
// and audit entries commit together. It is deliberately not wired into the
// legacy SQLite API; mount only from the isolated PostgreSQL HTTP runtime.
export function createPostgresInventoryRepository(database, options = {}) {
  if (!database || typeof database.q !== 'function' || typeof database.tx !== 'function') {
    throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  }
  const query = sql => database.q(sql);
  const generateId = options.id || defaultId;
  const getNow = options.now || defaultNow;

  async function listSellerInventory(sellerId) {
    if (!sellerId) throw new HttpError(401, 'লগইন প্রয়োজন');
    return query(`SELECT p.id,p.name_bn,p.name_en,p.sku,p.stock,p.active,p.status,p.updated_at
      FROM products p JOIN seller_profiles sp ON sp.user_id=p.seller_id
      WHERE p.seller_id=? AND sp.status='APPROVED'
      ORDER BY p.updated_at DESC,p.id DESC LIMIT 300`).all(sellerId);
  }

  async function adjustSellerStock(seller, productId, input = {}) {
    if (!seller?.id) throw new HttpError(401, 'লগইন প্রয়োজন');
    const { delta, reason, key } = validateAdjustment(input);
    const idempotencyKey = key;
    try {
      return await database.tx(async () => {
        const previous = await query(`SELECT id,product_id,quantity_delta,stock_before,stock_after,reason,created_at
          FROM inventory_movements WHERE seller_id=? AND idempotency_key=?`).get(seller.id, idempotencyKey);
        if (previous) return { ...previous, duplicate: true };

        const product = await query(`SELECT p.id,p.stock,p.seller_id
          FROM products p JOIN seller_profiles sp ON sp.user_id=p.seller_id
          WHERE p.id=? AND p.seller_id=? AND sp.status='APPROVED'
          FOR UPDATE OF p`).get(String(productId), seller.id);
        if (!product) throw new HttpError(404, 'পণ্যটি আপনার inventory-তে পাওয়া যায়নি');

        const before = safeStock(product.stock);
        const after = before + delta;
        if (!Number.isSafeInteger(after) || after < 0 || after > MAX_STOCK) {
          throw new HttpError(409, 'স্টকের পরিমাণ গ্রহণযোগ্য সীমার বাইরে');
        }

        const updated = await query(`UPDATE products SET stock=?,updated_at=?
          WHERE id=? AND seller_id=? AND stock=? RETURNING stock`)
          .all(after, getNow(), product.id, seller.id, before);
        if (updated.length !== 1) throw new HttpError(409, 'স্টক পরিবর্তিত হয়েছে; আবার চেষ্টা করুন');

        const movement = {
          id: generateId(),
          product_id: product.id,
          seller_id: seller.id,
          actor_id: seller.id,
          quantity_delta: delta,
          stock_before: before,
          stock_after: after,
          reason,
          idempotency_key: idempotencyKey,
          created_at: getNow()
        };
        await query(`INSERT INTO inventory_movements(
          id,product_id,seller_id,actor_id,quantity_delta,stock_before,stock_after,reason,idempotency_key,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          movement.id, movement.product_id, movement.seller_id, movement.actor_id,
          movement.quantity_delta, movement.stock_before, movement.stock_after,
          movement.reason, movement.idempotency_key, movement.created_at
        );
        await query(`INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at)
          VALUES(?,?,?,?,?,?,?)`).run(
          generateId(), seller.id, 'SELLER_INVENTORY_ADJUST', 'product', product.id,
          JSON.stringify({ delta, before, after, reason, idempotency_key: idempotencyKey }),
          movement.created_at
        );
        return { ...movement, duplicate: false };
      });
    } catch (error) {
      // Concurrent retries may both pass the initial lookup. The unique constraint
      // is the final arbiter; after rollback, return the already-committed movement.
      if (error?.code !== '23505') throw error;
      const previous = await query(`SELECT id,product_id,quantity_delta,stock_before,stock_after,reason,created_at
        FROM inventory_movements WHERE seller_id=? AND idempotency_key=?`).get(seller.id, idempotencyKey);
      if (previous) return { ...previous, duplicate: true };
      throw error;
    }
  }

  async function listMovements(sellerId, productId) {
    if (!sellerId) throw new HttpError(401, 'লগইন প্রয়োজন');
    const rows = await query(`SELECT id,product_id,quantity_delta,stock_before,stock_after,reason,created_at
      FROM inventory_movements WHERE seller_id=? AND product_id=?
      ORDER BY created_at DESC,id DESC LIMIT 100`).all(sellerId, String(productId));
    return rows;
  }

  return Object.freeze({ listSellerInventory, adjustSellerStock, listMovements });
}
