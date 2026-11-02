import { HttpError, bad, id, now, normPhone, validPhone, text, productView, LIVE } from './postgres-domain-helpers.mjs';

export function createPostgresCustomerRepository(database) {
  if (!database || typeof database.q !== 'function' || typeof database.tx !== 'function') {
    throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  }
  const query = sql => database.q(sql);

  function addressFields(body, user) {
    if (body.is_default !== undefined && typeof body.is_default !== 'boolean') throw bad('ডিফল্ট ঠিকানা নির্বাচন সঠিক নয়');
    const phone = normPhone(body.phone);
    if (!validPhone(phone)) throw bad('সঠিক মোবাইল নম্বর দিন');
    return [
      text(body.label, 40, 'লেবেল', { required: false }),
      text(body.name || user.name, 100, 'নাম'),
      phone,
      text(body.address, 500, 'ঠিকানা'),
      text(body.area, 100, 'এলাকা')
    ];
  }

  async function listAddresses(userId) {
    return query('SELECT id,label,name,phone,address,area,is_default FROM addresses WHERE user_id=? ORDER BY is_default DESC,id').all(userId);
  }

  async function createAddress({ user, body }) {
    const fields = addressFields(body, user);
    return database.tx(async () => {
      // Serialize per-customer address creation so the ten-address limit and
      // first/default-address selection cannot race under concurrent requests.
      const owner = await query('SELECT id FROM users WHERE id=? FOR UPDATE').get(user.id);
      if (!owner) throw new HttpError(404, 'Customer not found');
      const count = Number((await query('SELECT COUNT(*) AS n FROM addresses WHERE user_id=?').get(user.id))?.n || 0);
      if (count >= 10) throw bad('সর্বোচ্চ ১০টি ঠিকানা সংরক্ষণ করা যায়');
      const addressId = id();
      const isDefault = body.is_default || count === 0 ? 1 : 0;
      if (isDefault) await query('UPDATE addresses SET is_default=0 WHERE user_id=?').run(user.id);
      await query('INSERT INTO addresses(id,user_id,label,name,phone,address,area,is_default) VALUES(?,?,?,?,?,?,?,?)')
        .run(addressId, user.id, ...fields, isDefault);
      return { id: addressId };
    });
  }

  async function updateAddress({ user, addressId, body }) {
    const fields = addressFields(body, user);
    return database.tx(async () => {
      // All default-address mutations lock the customer row first. This gives
      // create/update/delete one consistent lock order and prevents two
      // concurrent requests from leaving multiple defaults behind.
      const owner = await query('SELECT id FROM users WHERE id=? FOR UPDATE').get(user.id);
      if (!owner) throw new HttpError(404, 'Customer not found');
      const existing = await query('SELECT id,is_default FROM addresses WHERE id=? AND user_id=? FOR UPDATE').get(addressId, user.id);
      if (!existing) throw new HttpError(404, 'Address not found');
      if (body.is_default === true) {
        await query('UPDATE addresses SET is_default=0 WHERE user_id=?').run(user.id);
      }
      const defaultValue = body.is_default === undefined ? null : body.is_default ? 1 : 0;
      await query('UPDATE addresses SET label=?,name=?,phone=?,address=?,area=?,is_default=COALESCE(?,is_default) WHERE id=? AND user_id=?')
        .run(...fields, defaultValue, addressId, user.id);
      if (body.is_default === false && existing.is_default) {
        await query(`UPDATE addresses SET is_default=1
          WHERE user_id=? AND id=(SELECT id FROM addresses WHERE user_id=? AND id<>? ORDER BY id LIMIT 1)`)
          .run(user.id, user.id, addressId);
      }
      return { id: addressId };
    });
  }

  async function deleteAddress(userId, addressId) {
    return database.tx(async () => {
      const owner = await query('SELECT id FROM users WHERE id=? FOR UPDATE').get(userId);
      if (!owner) throw new HttpError(404, 'Customer not found');
      const existing = await query('SELECT id,is_default FROM addresses WHERE id=? AND user_id=? FOR UPDATE').get(addressId, userId);
      if (!existing) return { deleted: true };
      await query('DELETE FROM addresses WHERE id=? AND user_id=?').run(addressId, userId);
      if (existing.is_default) {
        await query(`UPDATE addresses SET is_default=1
          WHERE user_id=? AND id=(SELECT id FROM addresses WHERE user_id=? ORDER BY id LIMIT 1)`)
          .run(userId, userId);
      }
      return { deleted: true };
    });
  }

  async function listWishlist(userId) {
    const rows = await query(`SELECT p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock
      FROM wishlists w JOIN products p ON p.id=w.product_id
      WHERE w.user_id=? AND ${LIVE} ORDER BY w.created_at DESC`).all(userId);
    return rows.map(productView);
  }

  async function addWishlist(userId, productId) {
    const product = await query(`SELECT 1 FROM products p WHERE p.id=? AND ${LIVE}`).get(String(productId || ''));
    if (!product) throw new HttpError(404, 'Product not found');
    await query('INSERT INTO wishlists(user_id,product_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,product_id) DO NOTHING')
      .run(userId, productId, now());
    return { added: true };
  }

  async function removeWishlist(userId, productId) {
    await query('DELETE FROM wishlists WHERE user_id=? AND product_id=?').run(userId, productId);
    return { removed: true };
  }

  async function saveReview({ userId, productId, body }) {
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('রেটিং ১ থেকে ৫ হতে হবে');
    const eligible = await query(`SELECT 1 FROM order_items oi
      JOIN seller_orders so ON so.id=oi.seller_order_id
      JOIN orders o ON o.id=oi.order_id
      WHERE o.user_id=? AND oi.product_id=? AND so.status='DELIVERED' LIMIT 1`).get(userId, productId);
    if (!eligible) throw new HttpError(403, 'শুধু ডেলিভারি পাওয়া পণ্যের রিভিউ দেওয়া যায়');
    await query(`INSERT INTO reviews(id,product_id,user_id,rating,comment,created_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(product_id,user_id) DO UPDATE
      SET rating=EXCLUDED.rating,comment=EXCLUDED.comment`)
      .run(id(), productId, userId, rating, text(body.comment, 1000, 'মন্তব্য', { required: false }), now());
    return { saved: true };
  }

  return Object.freeze({
    listAddresses, createAddress, updateAddress, deleteAddress,
    listWishlist, addWishlist, removeWishlist, saveReview
  });
}
