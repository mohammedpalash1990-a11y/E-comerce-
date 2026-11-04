import { createPostgresCartRepository } from './postgres-cart.mjs';

const cartView = cart => ({
  items: cart.items.map(item => ({
    product_id: item.product_id, name_bn: item.name_bn, name_en: item.name_en,
    quantity: item.quantity, stock: item.stock, image: item.image, available: item.available,
    unit_price_bdt: item.unit_price_paisa / 100, line_total_bdt: item.line_total_paisa / 100
  })),
  // Sum integer paisa before conversion, not floating-point display prices.
  subtotal_bdt: cart.subtotal_paisa / 100,
  item_count: cart.item_count
});

export function registerPostgresCartRoutes(route, ok, { database, cartRepository } = {}) {
  const cart = cartRepository || createPostgresCartRepository(database);
  route('GET', '/api/v1/customer/cart', ['CUSTOMER'], async ({ user }) =>
    ok(cartView(await cart.getCart(user.id))));
  route('PUT', '/api/v1/customer/cart', ['CUSTOMER'], async ({ user, body }) =>
    ok(cartView(await cart.setItemQuantity(user.id, body.productId, body.quantity))));
  route('DELETE', '/api/v1/customer/cart/:pid', ['CUSTOMER'], async ({ user, params }) =>
    ok(cartView(await cart.removeItem(user.id, params[0]))));
  route('DELETE', '/api/v1/customer/cart', ['CUSTOMER'], async ({ user }) =>
    ok(cartView(await cart.clearCart(user.id))));
}
