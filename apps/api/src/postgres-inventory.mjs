import { randomUUID } from 'node:crypto';

function safeInteger(value, label) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new TypeError(label + ' must be a safe integer');
  return n;
}
function requiredText(value, label, max = 200) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new TypeError(label + ' is required and must be at most ' + max + ' characters');
  return result;
}
function domainError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function createPostgresInventoryRepository(database, {
  createId = randomUUID,
  clock = () => new Date().toISOString()
} = {}) {
  if (!database || typeof database.q !== 'function' || typeof database.tx !== 'function') {
    throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  }
  const query = sql => database.q(sql);

  async function readProduct(productId, { lock = false } = {}) {
    return query('SELECT id,stock,active,status,seller_id,updated_at FROM products WHERE id=?' + (lock ? ' FOR UPDATE' : '')).get(String(productId));
  }

  async function recordChange({ productId, delta, reason, actorId = null, reference = null, targetStock = null }) {
    const amount = delta === null ? null : safeInteger(delta, 'delta');
    if (amount === 0) throw new TypeError('delta must not be zero');
    const note = requiredText(reason, 'reason', 200);
    const ref = reference == null || reference === '' ? null : requiredText(reference, 'reference', 160);
    return database.tx(async () => {
      const product = await readProduct(productId, { lock: true });
      if (!product) throw domainError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
      const before = safeInteger(product.stock, 'stock');
      const after = targetStock === null ? before + amount : safeInteger(targetStock, 'stock');
      const actualDelta = after - before;
      if (!Number.isSafeInteger(after) || after < 0 || after > 2147483647) {
        throw domainError(409, 'INVALID_STOCK', 'Stock must remain between 0 and 2147483647');
      }
      if (actualDelta === 0) return { product_id: product.id, stock: before, delta: 0, unchanged: true };
      const stamp = clock();
      const updated = await query('UPDATE products SET stock=?,updated_at=? WHERE id=? RETURNING id,stock')
        .get(after, stamp, product.id);
      if (!updated) throw domainError(409, 'STOCK_UPDATE_FAILED', 'Product stock could not be updated');
      const movementId = createId();
      await query('INSERT INTO inventory_movements(id,product_id,delta,stock_before,stock_after,reason,actor_id,reference,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(movementId, product.id, actualDelta, before, after, note, actorId || null, ref, stamp);
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(createId(), actorId || null, actualDelta > 0 ? 'STOCK_INCREASED' : 'STOCK_DECREASED',
          'product', product.id, JSON.stringify({ delta: actualDelta, before, after, reason: note, reference: ref }), stamp);
      return { product_id: product.id, stock: safeInteger(updated.stock, 'stock'), previous_stock: before, delta: actualDelta, movement_id: movementId };
    });
  }

  async function getStock(productId) {
    const row = await readProduct(productId);
    if (!row) return null;
    return { product_id: row.id, stock: safeInteger(row.stock, 'stock'), active: Boolean(row.active), status: row.status, seller_id: row.seller_id };
  }
  async function adjustStock(input = {}) {
    const delta = safeInteger(input.delta, 'delta');
    if (delta === 0) throw new TypeError('delta must not be zero');
    return recordChange({ ...input, delta });
  }
  async function setStock(input = {}) {
    const stock = safeInteger(input.stock, 'stock');
    if (stock < 0 || stock > 2147483647) throw new TypeError('stock is outside the supported range');
    return recordChange({ ...input, delta: null, targetStock: stock });
  }
  async function listMovements({ productId, reference, limit = 50, beforeCreatedAt, beforeId } = {}) {
    const clauses = [];
    const values = [];
    if (productId) { clauses.push('product_id=?'); values.push(String(productId)); }
    if (reference) { clauses.push('reference=?'); values.push(String(reference)); }
    if (beforeCreatedAt && beforeId) {
      clauses.push('(created_at,id)<(?,?)');
      values.push(String(beforeCreatedAt), String(beforeId));
    }
    const pageSize = Math.min(Math.max(safeInteger(limit, 'limit'), 1), 100);
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = await query('SELECT id,product_id,delta,stock_before,stock_after,reason,actor_id,reference,created_at FROM inventory_movements' + where + ' ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(...values, pageSize);
    return rows.map(row => ({
      ...row,
      delta: safeInteger(row.delta, 'delta'),
      stock_before: safeInteger(row.stock_before, 'stock_before'),
      stock_after: safeInteger(row.stock_after, 'stock_after')
    }));
  }
  return Object.freeze({ getStock, adjustStock, setStock, listMovements });
}
