import { bad, HttpError } from './postgres-shared.mjs';
import { createPostgresCartRepository, MAX_CART_ITEMS } from './postgres-cart.mjs';
import { createPostgresCouponRepository, normalizeCouponCode } from './postgres-coupons.mjs';

export function registerPostgresCouponRoutes(route, ok, { database } = {}) {
  const cart = createPostgresCartRepository(database);
  const coupons = createPostgresCouponRepository(database);
  route('POST', '/api/v1/coupons/validate', ['CUSTOMER'], async ({ user, body }) => {
    const code = normalizeCouponCode(body.code);
    if (code === null) throw bad('Coupon code is required');
    return database.tx(async () => {
      await database.q('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY').run();
      // Never authorize a discount or minimum-order threshold using the client's
      // subtotal_bdt. Preview uses only the authenticated customer's saved cart.
      const saved = await cart.getCart(user.id);
      if (!saved.items.length) throw bad('Cart is empty');
      if (saved.items.length > MAX_CART_ITEMS || saved.items.some(item => !item.available || item.quantity > 1000)) {
        throw new HttpError(409, 'Cart contains unavailable items; refresh your cart');
      }
      const coupon = await coupons.validateCoupon(code, saved.subtotal_paisa);
      return ok({ code: coupon.code, discount_bdt: coupon.discount / 100, subtotal_bdt: saved.subtotal_paisa / 100 });
    });
  });
}
