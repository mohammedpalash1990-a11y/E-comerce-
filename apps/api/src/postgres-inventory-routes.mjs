import { HttpError, text } from './postgres-shared.mjs';
import { createPostgresInventoryRepository } from './postgres-inventory.mjs';

// Register these routes only in the isolated PostgreSQL server. Role enforcement
// is supplied by the shared route dispatcher; ownership is rechecked in SQL.
export function registerPostgresInventoryRoutes(route, ok, options = {}) {
  const { database } = options;
  if (!database?.q || !database?.tx) throw new TypeError('PostgreSQL database is required');
  const inventory = options.inventoryRepository || createPostgresInventoryRepository(database);

  route('GET', '/api/v1/seller/inventory', ['SELLER'], async ({ user }) => {
    return ok(await inventory.listSellerInventory(user.id));
  });

  route('GET', '/api/v1/seller/inventory/:productId/movements', ['SELLER'], async ({ user, params }) => {
    return ok(await inventory.listMovements(user.id, params[0]));
  });

  route('POST', '/api/v1/seller/inventory/:productId/adjust', ['SELLER'], async ({ user, params, body }) => {
    const result = await inventory.adjustSellerStock(user, params[0], {
      delta: body.delta,
      reason: text(body.reason, 300, 'কারণ'),
      idempotencyKey: body.idempotency_key
    });
    return ok(result, result.duplicate ? 200 : 201);
  });

  return Object.freeze({ inventory });
}
