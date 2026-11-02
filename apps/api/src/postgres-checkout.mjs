import { randomUUID } from 'node:crypto';

const LIVE = "p.active=1 AND p.status='ACTIVE' AND sp.status='APPROVED'";
const METHODS = new Set(['COD', 'BKASH', 'NAGAD', 'ROCKET', 'SSLCOMMERZ']);

function safeInteger(value, label) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new TypeError(label + ' must be a safe integer');
  return n;
}
function text(value, label, max, { optional = false } = {}) {
  const result = String(value ?? '').trim();
  if ((!optional && !result) || result.length > max) throw new TypeError(label + ' is required and must be at most ' + max + ' characters');
  return result;
}
function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
function normalisePhone(value) {
  return String(value ?? '').replace(/[\s-]/g, '').replace(/^\+?88/, '');
}
function effectivePrice(row) {
  const price = safeInteger(row.price_paisa, 'price_paisa');
  const discount = row.discount_paisa == null ? null : safeInteger(row.discount_paisa, 'discount_paisa');
  return discount !== null && discount > 0 && discount < price ? discount : price;
}
function boundedQuantity(value, label = 'quantity') {
  const quantity = safeInteger(value, label);
  if (quantity < 1 || quantity > 1000) throw new TypeError(label + ' must be between 1 and 1000');
  return quantity;
}

export function createPostgresCheckoutRepository(database, {
  shippingForPaisa,
  createId = randomUUID,
  clock = () => new Date().toISOString()
} = {}) {
  if (!database || typeof database.q !== 'function' || typeof database.tx !== 'function') {
    throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  }
  if (typeof shippingForPaisa !== 'function') throw new TypeError('shippingForPaisa(area, subtotalPaisa) dependency is required');
  const query = sql => database.q(sql);

  async function activeProduct(productId, { lock = false } = {}) {
    return query(`SELECT p.id,p.name_bn,p.price_paisa,p.discount_paisa,p.stock,p.seller_id,sp.commission_bps
      FROM products p JOIN seller_profiles sp ON sp.user_id=p.seller_id
      WHERE p.id=? AND ${LIVE}${lock ? ' FOR UPDATE OF p,sp' : ''}`).get(String(productId));
  }
  async function getCart(userId) {
    const rows = await query(`SELECT ci.product_id,ci.quantity,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,
        p.active,p.status,sp.status seller_status,
        (SELECT url FROM product_images i WHERE i.product_id=p.id ORDER BY position,i.id LIMIT 1) image
      FROM cart_items ci JOIN products p ON p.id=ci.product_id
      LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id
      WHERE ci.user_id=? ORDER BY ci.product_id`).all(String(userId));
    const items = rows.map(row => {
      const quantity = safeInteger(row.quantity, 'quantity');
      const stock = safeInteger(row.stock, 'stock');
      const available = Number(row.active) === 1 && row.status === 'ACTIVE' && row.seller_status === 'APPROVED' && stock >= quantity;
      const unit = effectivePrice(row);
      return {
        product_id: row.product_id, name_bn: row.name_bn, name_en: row.name_en, image: row.image || null,
        quantity, stock, unit_price_paisa: unit, line_total_paisa: safeInteger(unit * quantity, 'line_total_paisa'), available
      };
    });
    const subtotal = items.reduce((sum, item) => sum + item.line_total_paisa, 0);
    return { items, subtotal_paisa: safeInteger(subtotal, 'subtotal_paisa'), item_count: items.reduce((sum, item) => sum + item.quantity, 0) };
  }
  async function addItem(userId, productId, quantity) {
    const amount = boundedQuantity(quantity);
    return database.tx(async () => {
      const product = await activeProduct(productId, { lock: true });
      if (!product) throw fail(404, 'PRODUCT_UNAVAILABLE', 'Product is unavailable');
      const existing = await query('SELECT quantity FROM cart_items WHERE user_id=? AND product_id=? FOR UPDATE').get(String(userId), String(productId));
      const next = safeInteger(existing?.quantity || 0, 'cart quantity') + amount;
      if (next > 1000 || next > safeInteger(product.stock, 'stock')) throw fail(409, 'INSUFFICIENT_STOCK', 'Requested quantity exceeds available stock');
      await query('INSERT INTO cart_items(user_id,product_id,quantity) VALUES(?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity')
        .run(String(userId), String(productId), next);
      return getCart(userId);
    });
  }
  async function setItemQuantity(userId, productId, quantity) {
    const amount = safeInteger(quantity, 'quantity');
    if (amount < 0 || amount > 1000) throw new TypeError('quantity must be between 0 and 1000');
    if (amount === 0) {
      await query('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(String(userId), String(productId));
      return getCart(userId);
    }
    return database.tx(async () => {
      const product = await activeProduct(productId, { lock: true });
      if (!product) throw fail(404, 'PRODUCT_UNAVAILABLE', 'Product is unavailable');
      if (amount > safeInteger(product.stock, 'stock')) throw fail(409, 'INSUFFICIENT_STOCK', 'Requested quantity exceeds available stock');
      await query('INSERT INTO cart_items(user_id,product_id,quantity) VALUES(?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity')
        .run(String(userId), String(productId), amount);
      return getCart(userId);
    });
  }
  async function removeItem(userId, productId) {
    await query('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(String(userId), String(productId));
    return getCart(userId);
  }
  async function clearCart(userId) {
    await query('DELETE FROM cart_items WHERE user_id=?').run(String(userId));
    return { items: [], subtotal_paisa: 0, item_count: 0 };
  }
  async function validateCoupon(code, subtotalPaisa, { lock = false } = {}) {
    if (!code) return null;
    const normalized = text(code, 'coupon code', 30).toUpperCase();
    const coupon = await query('SELECT * FROM coupons WHERE code=? AND active=1' + (lock ? ' FOR UPDATE' : '')).get(normalized);
    const now = clock();
    if (!coupon || (coupon.expires_at && coupon.expires_at < now) ||
        (coupon.max_uses !== null && safeInteger(coupon.used_count, 'used_count') >= safeInteger(coupon.max_uses, 'max_uses'))) {
      throw fail(400, 'INVALID_COUPON', 'Coupon is invalid or expired');
    }
    const minimum = safeInteger(coupon.min_order_paisa, 'min_order_paisa');
    if (subtotalPaisa < minimum) throw fail(400, 'MINIMUM_ORDER_NOT_MET', 'Coupon minimum order amount has not been met');
    const value = safeInteger(coupon.value, 'coupon value');
    if (coupon.type === 'PERCENT' && (value < 1 || value > 90)) throw fail(400, 'INVALID_COUPON', 'Coupon percentage is invalid');
    if (!['FIXED', 'PERCENT'].includes(coupon.type)) throw fail(400, 'INVALID_COUPON', 'Coupon type is invalid');
    const discount = coupon.type === 'PERCENT' ? Math.floor(subtotalPaisa * value / 100) : value;
    return { code: coupon.code, discount_paisa: Math.min(discount, subtotalPaisa) };
  }
  async function checkout({ userId, items: requestedItems, delivery = {}, paymentMethod = 'COD', couponCode = null } = {}) {
    const uid = text(userId, 'userId', 160);
    const name = text(delivery.name, 'delivery name', 100);
    const phone = normalisePhone(delivery.phone);
    if (!/^01[3-9]\d{8}$/.test(phone)) throw fail(400, 'INVALID_PHONE', 'A valid Bangladesh mobile number is required');
    const address = text(delivery.address, 'delivery address', 500);
    const area = text(delivery.area, 'delivery area', 100);
    const note = text(delivery.note, 'delivery note', 500, { optional: true });
    const method = String(paymentMethod || 'COD').toUpperCase();
    if (!METHODS.has(method)) throw fail(400, 'INVALID_PAYMENT_METHOD', 'Unsupported payment method');
    const fromCart = !Array.isArray(requestedItems);
    const orderId = createId();

    const result = await database.tx(async () => {
      const rawItems = fromCart
        ? await query("SELECT product_id productId,quantity,'' variant FROM cart_items WHERE user_id=? ORDER BY product_id FOR UPDATE").all(uid)
        : requestedItems;
      if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 50) {
        throw fail(400, 'INVALID_CART', 'Checkout must contain between 1 and 50 items');
      }
      const requested = new Map();
      for (const item of rawItems) {
        const productId = text(item?.productId, 'productId', 160);
        const quantity = boundedQuantity(item?.quantity);
        const variant = text(item?.variant, 'variant', 60, { optional: true });
        const current = requested.get(productId);
        if (current && current.variant !== variant) throw fail(400, 'DUPLICATE_VARIANT', 'Use one cart line per product and variant');
        requested.set(productId, { productId, quantity: (current?.quantity || 0) + quantity, variant });
      }
      if ([...requested.values()].some(item => item.quantity > 1000)) throw fail(400, 'INVALID_QUANTITY', 'Maximum quantity per product is 1000');

      const lines = [];
      let subtotal = 0;
      for (const item of requested.values()) {
        const product = await activeProduct(item.productId, { lock: true });
        if (!product || safeInteger(product.stock, 'stock') < item.quantity) {
          throw fail(409, 'INSUFFICIENT_STOCK', 'A product is unavailable or has insufficient stock');
        }
        const unit = effectivePrice(product);
        const lineTotal = safeInteger(unit * item.quantity, 'line total');
        subtotal = safeInteger(subtotal + lineTotal, 'subtotal');
        lines.push({ ...item, name: product.name_bn, unit, sellerId: product.seller_id, commissionBps: safeInteger(product.commission_bps, 'commission_bps') });
      }

      const coupon = await validateCoupon(couponCode, subtotal, { lock: true });
      const shipping = safeInteger(await shippingForPaisa(area, subtotal), 'shipping_paisa');
      const discount = coupon?.discount_paisa || 0;
      const total = safeInteger(subtotal + shipping - discount, 'total_paisa');
      if (shipping < 0 || total < 0) throw fail(400, 'INVALID_TOTAL', 'Calculated checkout total is invalid');

      const stamp = clock();
      for (const line of lines) {
        const changed = await query("UPDATE products SET stock=stock-?,updated_at=? WHERE id=? AND stock>=? AND active=1 AND status='ACTIVE' RETURNING id,stock")
          .get(line.quantity, stamp, line.productId, line.quantity);
        if (!changed) throw fail(409, 'STOCK_CHANGED', 'Stock changed during checkout; refresh the cart');
        const after = safeInteger(changed.stock, 'stock');
        await query('INSERT INTO inventory_movements(id,product_id,delta,stock_before,stock_after,reason,actor_id,reference,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(createId(), line.productId, -line.quantity, after + line.quantity, after, 'ORDER_CHECKOUT', uid, orderId, stamp);
      }

      const online = method !== 'COD';
      const initialStatus = online ? 'AWAITING_PAYMENT' : 'CONFIRMED';
      await query(`INSERT INTO orders(id,user_id,total_paisa,status,created_at,delivery_name,delivery_phone,delivery_address,delivery_area,customer_note,subtotal_paisa,shipping_paisa,discount_paisa,coupon_code,payment_method,payment_status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(orderId, uid, total, initialStatus, stamp, name, phone, address, area, note, subtotal, shipping, discount, coupon?.code || null, method, 'PENDING');

      if (coupon) {
        const used = await query('UPDATE coupons SET used_count=used_count+1 WHERE code=? AND active=1 AND (max_uses IS NULL OR used_count<max_uses) RETURNING code')
          .get(coupon.code);
        if (!used) throw fail(409, 'COUPON_EXHAUSTED', 'Coupon usage limit has been reached');
      }

      const grouped = new Map();
      for (const line of lines) {
        if (!grouped.has(line.sellerId)) grouped.set(line.sellerId, []);
        grouped.get(line.sellerId).push(line);
      }
      for (const [sellerId, sellerLines] of grouped) {
        const sellerSubtotal = safeInteger(sellerLines.reduce((sum, line) => sum + line.unit * line.quantity, 0), 'seller subtotal');
        const basisPoints = sellerLines[0].commissionBps;
        if (sellerLines.some(line => line.commissionBps !== basisPoints)) throw fail(409, 'COMMISSION_CHANGED', 'Seller commission changed during checkout');
        const commission = Math.floor(sellerSubtotal * basisPoints / 10000);
        const sellerOrderId = createId();
        await query('INSERT INTO seller_orders(id,order_id,seller_id,status,subtotal_paisa,created_at,commission_paisa,net_paisa) VALUES(?,?,?,?,?,?,?,?)')
          .run(sellerOrderId, orderId, sellerId, initialStatus, sellerSubtotal, stamp, commission, sellerSubtotal - commission);
        for (const line of sellerLines) {
          await query('INSERT INTO order_items(id,order_id,product_id,product_name_bn,quantity,unit_price_paisa,seller_id,seller_order_id,variant) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(createId(), orderId, line.productId, line.name, line.quantity, line.unit, sellerId, sellerOrderId, line.variant);
        }
        if (!online) {
          await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
            .run(createId(), sellerId, 'নতুন অর্ডার', orderId, stamp);
        }
      }

      // Gateway initiation is a separate post-commit operation. This row is intentionally PENDING.
      const paymentId = createId();
      await query('INSERT INTO payments(id,order_id,method,amount_paisa,status,gateway_txn_id,raw,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(paymentId, orderId, method, total, 'PENDING', null, '{}', stamp, stamp);
      if (fromCart) await query('DELETE FROM cart_items WHERE user_id=?').run(uid);
      else for (const item of requested.values()) await query('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(uid, item.productId);
      await query('INSERT INTO order_events(id,order_id,seller_order_id,status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(createId(), orderId, null, initialStatus, 'অর্ডার তৈরি', uid, stamp);
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(createId(), uid, 'CHECKOUT', 'order', orderId, JSON.stringify({ total, subtotal, shipping, discount, method }), stamp);
      return { payment_id: paymentId, total_paisa: total, subtotal_paisa: subtotal, shipping_paisa: shipping, discount_paisa: discount, status: initialStatus, payment_status: 'PENDING', payment_method: method };
    });
    return { id: orderId, ...result };
  }

  return Object.freeze({ getCart, addItem, setItemQuantity, removeItem, clearCart, validateCoupon, checkout });
}
