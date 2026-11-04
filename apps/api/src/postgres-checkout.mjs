import { bad, HttpError, id as defaultId, now as defaultNow, normPhone, validPhone, text } from './postgres-shared.mjs';

const LIVE_PRODUCT = "p.active=1 AND p.status='ACTIVE' AND EXISTS(SELECT 1 FROM seller_profiles sp WHERE sp.user_id=p.seller_id AND sp.status='APPROVED')";

function safePaisa(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw bad(label + ' সঠিক নয়');
  return amount;
}

function effectivePrice(product) {
  const price = safePaisa(product.price_paisa, 'পণ্যের মূল্য');
  const discount = product.discount_paisa == null ? null : safePaisa(product.discount_paisa, 'ছাড়ের মূল্য');
  return discount !== null && discount > 0 && discount < price ? discount : price;
}

// PostgreSQL checkout unit. Every read that determines price, seller, or stock is
// performed inside one transaction; product rows are locked before stock is reserved.
export function createPostgresCheckoutRepository(database, options = {}) {
  if (!database || typeof database.q !== 'function' || typeof database.tx !== 'function') {
    throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  }
  const query = sql => database.q(sql);
  const generateId = options.id || defaultId;
  const getNow = options.now || defaultNow;
  const shippingFor = options.shippingFor;
  const couponFor = options.couponFor || (async () => null);
  const paymentMethods = new Set(options.paymentMethods || ['COD']);
  const startPayment = options.startPayment;
  const notify = options.notify || (async () => {});
  const audit = options.audit || (async () => {});
  const addEvent = options.addEvent || (async () => {});
  const orderNo = options.orderNo || (value => value);

  async function checkout(user, body = {}) {
    if (!user?.id) throw new HttpError(401, 'লগইন প্রয়োজন');
    const d = body.delivery || {};
    const delivery = {
      name: text(d.name, 100, 'নাম'),
      phone: normPhone(d.phone),
      address: text(d.address, 500, 'পূর্ণ ঠিকানা'),
      area: text(d.area, 100, 'এলাকা'),
      note: text(d.note, 500, 'নোট', { required: false })
    };
    if (!validPhone(delivery.phone)) throw bad('সঠিক বাংলাদেশি মোবাইল নম্বর দিন');

    const method = String(body.payment_method || 'COD').toUpperCase();
    if (!paymentMethods.has(method)) throw bad('অজানা পেমেন্ট পদ্ধতি');
    if (method !== 'COD' && typeof startPayment !== 'function') {
      throw bad('অনলাইন পেমেন্ট সার্ভিস এখনো সংযুক্ত নয়');
    }
    if (typeof shippingFor !== 'function') {
      throw new HttpError(503, 'ডেলিভারি চার্জ নীতিমালা কনফিগার করা হয়নি; অর্ডার নেওয়া যাচ্ছে না');
    }

    const fromCart = !Array.isArray(body.items);
    const raw = fromCart
      ? await query('SELECT product_id productId,quantity FROM cart_items WHERE user_id=?').all(user.id)
      : body.items;
    if (!raw.length || raw.length > 50) throw bad('Cart must contain between 1 and 50 items');

    const quantities = new Map();
    const variants = new Map();
    for (const item of raw) {
      const productId = String(item.productId || '');
      const quantity = Number(item.quantity);
      if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
        throw bad('Invalid cart item');
      }
      quantities.set(productId, (quantities.get(productId) || 0) + quantity);
      variants.set(productId, String(item.variant || '').slice(0, 60));
    }
    for (const quantity of quantities.values()) {
      if (quantity > 1000) throw bad('একটি পণ্যের সর্বোচ্চ পরিমাণ ১০০০');
    }

    const orderId = generateId();
    const result = await database.tx(async () => {
      const lines = [];
      let subtotal = 0;

      // Lock product rows in deterministic ID order to reduce deadlock risk when
      // two carts contain overlapping products in different display orders.
      for (const [productId, quantity] of [...quantities].sort(([a], [b]) => a.localeCompare(b))) {
        const product = await query(`SELECT p.* FROM products p WHERE p.id=? AND ${LIVE_PRODUCT} FOR UPDATE OF p`).get(productId);
        if (!product || Number(product.stock) < quantity) {
          throw new HttpError(409, 'পণ্যটি আর উপলব্ধ নেই অথবা স্টকে যথেষ্ট পরিমাণ নেই');
        }
        const unit = effectivePrice(product);
        const lineTotal = unit * quantity;
        if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotal + lineTotal)) {
          throw bad('Order total is too large');
        }
        subtotal += lineTotal;
        lines.push({
          productId,
          quantity,
          name: product.name_bn,
          unit,
          sellerId: product.seller_id,
          variant: variants.get(productId)
        });
      }

      const coupon = await couponFor(body.coupon_code, subtotal, { lock: true });
      const discount = safePaisa(coupon?.discount || 0, 'কুপনের ছাড়');
      if (discount > subtotal) throw bad('কুপনের ছাড় অর্ডারের মূল্যের চেয়ে বেশি হতে পারে না');
      const shipping = safePaisa(await shippingFor(delivery.area, subtotal), 'ডেলিভারি চার্জ');
      const total = subtotal + shipping - discount;
      if (!Number.isSafeInteger(total) || total < 0) throw bad('Order total is too large');

      for (const line of lines) {
        const reserved = await query("UPDATE products SET stock=stock-? WHERE id=? AND stock>=? AND active=1 AND status='ACTIVE' RETURNING id")
          .all(line.quantity, line.productId, line.quantity);
        if (reserved.length !== 1) throw new HttpError(409, 'স্টক পরিবর্তিত হয়েছে; কার্ট রিফ্রেশ করুন');
      }

      const online = method !== 'COD';
      const initialStatus = online ? 'AWAITING_PAYMENT' : 'CONFIRMED';
      const timestamp = getNow();
      await query(`INSERT INTO orders(
        id,user_id,total_paisa,status,created_at,delivery_name,delivery_phone,delivery_address,
        delivery_area,customer_note,subtotal_paisa,shipping_paisa,discount_paisa,coupon_code,
        payment_method,payment_status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        orderId, user.id, total, initialStatus, timestamp, delivery.name, delivery.phone,
        delivery.address, delivery.area, delivery.note, subtotal, shipping, discount,
        coupon?.code || null, method, 'PENDING'
      );

      if (coupon?.code) {
        const used = await query('UPDATE coupons SET used_count=used_count+1 WHERE code=? AND active=1 AND (max_uses IS NULL OR used_count<max_uses) RETURNING code')
          .all(coupon.code);
        if (used.length !== 1) throw new HttpError(409, 'কুপনের ব্যবহারসীমা শেষ');
      }

      const groups = new Map();
      for (const line of lines) {
        if (!line.sellerId) throw new HttpError(409, 'পণ্যের বিক্রেতা নির্ধারিত নয়');
        if (!groups.has(line.sellerId)) groups.set(line.sellerId, []);
        groups.get(line.sellerId).push(line);
      }

      for (const [sellerId, sellerLines] of groups) {
        const sellerSubtotal = sellerLines.reduce((sum, line) => sum + line.unit * line.quantity, 0);
        const seller = await query('SELECT commission_bps FROM seller_profiles WHERE user_id=? AND status=\'APPROVED\' FOR UPDATE').get(sellerId);
        if (!seller) throw new HttpError(409, 'বিক্রেতা বর্তমানে অর্ডার নিতে পারছেন না');
        const bps = Number(seller.commission_bps);
        if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error('Invalid seller commission configuration');
        const commission = Math.floor(sellerSubtotal * bps / 10000);
        const sellerOrderId = generateId();
        await query(`INSERT INTO seller_orders(
          id,order_id,seller_id,status,subtotal_paisa,created_at,commission_paisa,net_paisa
        ) VALUES(?,?,?,?,?,?,?,?)`).run(
          sellerOrderId, orderId, sellerId, initialStatus, sellerSubtotal, timestamp,
          commission, sellerSubtotal - commission
        );
        for (const line of sellerLines) {
          await query(`INSERT INTO order_items(
            id,order_id,product_id,product_name_bn,quantity,unit_price_paisa,seller_id,seller_order_id,variant
          ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
            generateId(), orderId, line.productId, line.name, line.quantity, line.unit,
            sellerId, sellerOrderId, line.variant
          );
        }
        if (!online) await notify(sellerId, 'নতুন অর্ডার', orderNo(orderId));
      }

      await query(`INSERT INTO payments(
        id,order_id,method,amount_paisa,status,gateway_txn_id,raw,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        generateId(), orderId, method, total, 'PENDING', null, '{}', timestamp, timestamp
      );

      if (fromCart) {
        await query('DELETE FROM cart_items WHERE user_id=?').run(user.id);
      } else {
        for (const productId of quantities.keys()) {
          await query('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(user.id, productId);
        }
      }

      await addEvent(orderId, null, initialStatus, 'অর্ডার তৈরি', user.id);
      await audit(user.id, 'CHECKOUT', 'order', orderId, { total, method });

      let payment = { method, status: 'PENDING' };
      if (online) {
        await query("DELETE FROM payments WHERE order_id=? AND method=? AND status='PENDING'").run(orderId, method);
        payment = await startPayment({ id: orderId, total_paisa: total }, method);
      }
      return { total, subtotal, shipping, discount, status: initialStatus, payment };
    });

    return {
      id: orderId,
      orderNumber: orderNo(orderId),
      total_bdt: result.total / 100,
      subtotal_bdt: result.subtotal / 100,
      shipping_bdt: result.shipping / 100,
      discount_bdt: result.discount / 100,
      status: result.status,
      payment: result.payment
    };
  }

  return Object.freeze({ checkout });
}
