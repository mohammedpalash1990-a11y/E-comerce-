import { createPostgresCustomerRepository } from './postgres-customer.mjs';

// Customer account surface: saved delivery addresses, wishlist and
// verified-purchase reviews. All routes are CUSTOMER-only and always derive the
// owner from the authenticated session, never from the request body.
export function registerPostgresCustomerAccountRoutes(route, ok, { database, customerRepository } = {}) {
  const customers = customerRepository || (database ? createPostgresCustomerRepository(database) : null);
  if (!customers || typeof customers.listAddresses !== 'function') {
    throw new TypeError('A PostgreSQL customer repository (or database adapter) is required');
  }

  route('GET', '/api/v1/customer/addresses', ['CUSTOMER'], async ({ user }) =>
    ok(await customers.listAddresses(user.id)));
  route('POST', '/api/v1/customer/addresses', ['CUSTOMER'], async ({ user, body }) =>
    ok(await customers.createAddress({ user, body }), 201));
  route('PUT', '/api/v1/customer/addresses/:id', ['CUSTOMER'], async ({ user, params, body }) =>
    ok(await customers.updateAddress({ user, addressId: params[0], body })));
  route('DELETE', '/api/v1/customer/addresses/:id', ['CUSTOMER'], async ({ user, params }) =>
    ok(await customers.deleteAddress(user.id, params[0])));

  route('GET', '/api/v1/customer/wishlist', ['CUSTOMER'], async ({ user }) =>
    ok(await customers.listWishlist(user.id)));
  route('POST', '/api/v1/customer/wishlist', ['CUSTOMER'], async ({ user, body }) =>
    ok(await customers.addWishlist(user.id, body?.productId), 201));
  route('DELETE', '/api/v1/customer/wishlist/:pid', ['CUSTOMER'], async ({ user, params }) =>
    ok(await customers.removeWishlist(user.id, params[0])));

  route('POST', '/api/v1/customer/products/:id/reviews', ['CUSTOMER'], async ({ user, params, body }) =>
    ok(await customers.saveReview({ userId: user.id, productId: params[0], body }), 201));

  return Object.freeze({ customers });
}
