import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresCustomerRepository } from '../apps/api/src/postgres-customer.mjs';
import { HttpError } from '../apps/api/src/postgres-domain-helpers.mjs';

function fakeDatabase(handler) {
  const calls = [];
  return {
    calls,
    q(sql) {
      return {
        async get(...values) { calls.push({ method: 'get', sql, values }); return handler('get', sql, values, calls.length); },
        async all(...values) { calls.push({ method: 'all', sql, values }); return handler('all', sql, values, calls.length) || []; },
        async run(...values) { calls.push({ method: 'run', sql, values }); return handler('run', sql, values, calls.length) || { changes: 1 }; }
      };
    },
    async tx(callback) { calls.push({ method: 'tx' }); return callback(); }
  };
}

const customer = { id: 'customer-1', name: 'Buyer' };
const validAddress = {
  label: 'Home', name: 'Buyer', phone: '01711111111',
  address: 'Road 1, House 2', area: 'Dhaka', is_default: true
};

test('customer address creation locks the owner row and enforces the ten-address cap', async () => {
  const db = fakeDatabase((method, sql) => {
    if (sql.includes('FROM users')) return { id: customer.id };
    if (sql.includes('COUNT(*)')) return { n: '9' };
    return { changes: 1 };
  });
  const repo = createPostgresCustomerRepository(db);
  const result = await repo.createAddress({ user: customer, body: validAddress });
  assert.ok(result.id);
  assert.ok(db.calls.some(call => call.sql?.includes('FROM users WHERE id=? FOR UPDATE')));
  assert.ok(db.calls.some(call => /UPDATE addresses SET is_default=0/.test(call.sql)));
  assert.ok(db.calls.some(call => /INSERT INTO addresses/.test(call.sql)));
});

test('customer cannot create an eleventh saved address', async () => {
  const db = fakeDatabase((method, sql) => {
    if (sql.includes('FROM users')) return { id: customer.id };
    if (sql.includes('COUNT(*)')) return { n: '10' };
    return { changes: 1 };
  });
  const repo = createPostgresCustomerRepository(db);
  await assert.rejects(repo.createAddress({ user: customer, body: validAddress }),
    error => error instanceof HttpError && error.status === 400 && error.message === 'সর্বোচ্চ ১০টি ঠিকানা সংরক্ষণ করা যায়');
  assert.equal(db.calls.some(call => /INSERT INTO addresses/.test(call.sql)), false);
});

test('address update is owner-scoped and cannot edit another customer address', async () => {
  const db = fakeDatabase((method, sql) => sql.includes('SELECT id FROM addresses') ? undefined : { changes: 1 });
  const repo = createPostgresCustomerRepository(db);
  await assert.rejects(repo.updateAddress({ user: customer, addressId: 'foreign-address', body: validAddress }),
    error => error instanceof HttpError && error.status === 404 && error.message === 'Address not found');
  assert.ok(db.calls.some(call => call.sql?.includes('WHERE id=? AND user_id=? FOR UPDATE')));
  assert.equal(db.calls.some(call => /UPDATE addresses SET label=/.test(call.sql)), false);
});

test('wishlist only accepts visible products and returns the existing product view fields', async () => {
  const db = fakeDatabase((method, sql) => {
    if (sql.includes('SELECT 1 FROM products')) return { ok: 1 };
    if (sql.includes('FROM wishlists')) return [{
      id: 'p-1', name_bn: 'চা', name_en: 'Tea', price_paisa: '20000',
      discount_paisa: '15000', stock: '3'
    }];
    return { changes: 1 };
  });
  const repo = createPostgresCustomerRepository(db);
  const added = await repo.addWishlist(customer.id, 'p-1');
  const items = await repo.listWishlist(customer.id);
  assert.deepEqual(added, { added: true });
  assert.equal(items[0].price_bdt, 200);
  assert.equal(items[0].sale_price_bdt, 150);
  assert.equal(items[0].in_stock, true);
  assert.match(db.calls.find(call => call.sql.includes('FROM wishlists')).sql, /seller_profiles/);
});

test('wishlist rejects hidden or unapproved-seller products', async () => {
  const db = fakeDatabase(() => undefined);
  const repo = createPostgresCustomerRepository(db);
  await assert.rejects(repo.addWishlist(customer.id, 'hidden-product'),
    error => error instanceof HttpError && error.status === 404);
});

test('reviews require a delivered purchase and upsert the customer review', async () => {
  const db = fakeDatabase((method, sql) => sql.includes('FROM order_items') ? { eligible: true } : { changes: 1 });
  const repo = createPostgresCustomerRepository(db);
  assert.deepEqual(await repo.saveReview({ userId: customer.id, productId: 'p-1', body: { rating: 5, comment: 'ভালো' } }), { saved: true });
  assert.match(db.calls.find(call => call.sql.includes('FROM order_items')).sql, /so.status='DELIVERED'/);
  assert.match(db.calls.find(call => call.sql.includes('INSERT INTO reviews')).sql, /ON CONFLICT\(product_id,user_id\) DO UPDATE/);
});

test('reviews reject invalid ratings and purchases that were not delivered', async () => {
  const invalidDb = fakeDatabase(() => undefined);
  const invalidRepo = createPostgresCustomerRepository(invalidDb);
  await assert.rejects(invalidRepo.saveReview({ userId: customer.id, productId: 'p-1', body: { rating: 6 } }), /রেটিং ১ থেকে ৫ হতে হবে/);
  assert.equal(invalidDb.calls.length, 0);

  const pendingDb = fakeDatabase(() => undefined);
  const pendingRepo = createPostgresCustomerRepository(pendingDb);
  await assert.rejects(pendingRepo.saveReview({ userId: customer.id, productId: 'p-1', body: { rating: 4 } }),
    error => error instanceof HttpError && error.status === 403);
  assert.equal(pendingDb.calls.length, 1);
});

test('repository requires the async PostgreSQL database adapter', () => {
  assert.throws(() => createPostgresCustomerRepository({}), /q\(\) and tx\(\)/);
});


test('address default can be explicitly cleared and another saved address is promoted', async () => {
  const db = fakeDatabase((method, sql) => {
    if (sql.includes('FROM users WHERE id=? FOR UPDATE')) return { id: customer.id };
    if (sql.includes('SELECT id,is_default FROM addresses')) return { id: 'address-1', is_default: 1 };
    return { changes: 1 };
  });
  const repo = createPostgresCustomerRepository(db);
  await repo.updateAddress({
    user: customer,
    addressId: 'address-1',
    body: { ...validAddress, is_default: false }
  });
  const ownerLock = db.calls.findIndex(call => call.sql?.includes('FROM users WHERE id=? FOR UPDATE'));
  const addressLock = db.calls.findIndex(call => call.sql?.includes('SELECT id,is_default FROM addresses'));
  const update = db.calls.find(call => call.sql?.includes('SET label=?,name=?,phone=?,address=?,area=?,is_default=COALESCE'));
  const promote = db.calls.find(call => call.sql?.includes('ORDER BY id LIMIT 1'));
  assert.ok(ownerLock >= 0 && addressLock > ownerLock, 'customer lock must be acquired before address lock');
  assert.equal(update.values[5], 0, 'explicit false must be persisted, not treated as undefined');
  assert.ok(promote, 'another saved address should become the default');
});

test('deleting the default address promotes a remaining saved address under the customer lock', async () => {
  const db = fakeDatabase((method, sql) => {
    if (sql.includes('FROM users WHERE id=? FOR UPDATE')) return { id: customer.id };
    if (sql.includes('SELECT id,is_default FROM addresses')) return { id: 'address-default', is_default: 1 };
    return { changes: 1 };
  });
  const repo = createPostgresCustomerRepository(db);
  assert.deepEqual(await repo.deleteAddress(customer.id, 'address-default'), { deleted: true });
  const ownerLock = db.calls.findIndex(call => call.sql?.includes('FROM users WHERE id=? FOR UPDATE'));
  const addressLock = db.calls.findIndex(call => call.sql?.includes('SELECT id,is_default FROM addresses'));
  const deletion = db.calls.findIndex(call => call.sql?.startsWith('DELETE FROM addresses'));
  const promote = db.calls.findIndex(call => call.sql?.includes('ORDER BY id LIMIT 1'));
  assert.ok(ownerLock >= 0 && addressLock > ownerLock && deletion > addressLock);
  assert.ok(promote > deletion, 'default replacement must happen after deletion');
});

test('deleting a non-default address does not rewrite the remaining default', async () => {
  const db = fakeDatabase((method, sql) => {
    if (sql.includes('FROM users WHERE id=? FOR UPDATE')) return { id: customer.id };
    if (sql.includes('SELECT id,is_default FROM addresses')) return { id: 'address-secondary', is_default: 0 };
    return { changes: 1 };
  });
  const repo = createPostgresCustomerRepository(db);
  await repo.deleteAddress(customer.id, 'address-secondary');
  assert.equal(db.calls.some(call => call.sql?.includes('ORDER BY id LIMIT 1')), false);
});
