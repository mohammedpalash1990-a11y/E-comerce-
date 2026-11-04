import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresCartRepository, MAX_CART_ITEMS } from '../apps/api/src/postgres-cart.mjs';
import { registerPostgresCartRoutes } from '../apps/api/src/postgres-cart-routes.mjs';

function setup({ owner = true, count, rows } = {}) {
  const calls = [], cart = new Map(), products = new Map([
    ['p1', { name_bn: 'চা', name_en: 'Tea', stock: '10', price_paisa: '101', discount_paisa: '99', active: 1, status: 'ACTIVE', seller_status: 'APPROVED', image: null }],
    ['p2', { name_bn: 'মগ', name_en: 'Mug', stock: '10', price_paisa: '202', discount_paisa: null, active: 1, status: 'ACTIVE', seller_status: 'APPROVED', image: null }]
  ]);
  const db = {
    async tx(fn) {
      calls.push({ sql: 'BEGIN' });
      const before = new Map(cart);
      try { const result = await fn(); calls.push({ sql: 'COMMIT' }); return result; }
      catch (error) { cart.clear(); for (const pair of before) cart.set(...pair); calls.push({ sql: 'ROLLBACK' }); throw error; }
    },
    q(sql) { return {
      async get(...args) {
        calls.push({ sql, args });
        if (sql.includes('FROM users')) return owner ? { id: args[0] } : undefined;
        if (sql.includes('FROM products')) {
          const p = products.get(args[0]);
          return p?.active === 1 && p.status === 'ACTIVE' && p.seller_status === 'APPROVED' ? p : undefined;
        }
        if (sql.includes('COUNT(*)')) return { n: count ?? [...cart.keys()].filter(key => key.startsWith(args[0] + ':')).length };
        if (sql.includes('FROM cart_items')) {
          const quantity = cart.get(args.join(':'));
          return quantity === undefined ? undefined : { quantity };
        }
        throw new Error('Unexpected get: ' + sql);
      },
      async all(...args) {
        calls.push({ sql, args });
        if (rows) return rows;
        return [...cart].filter(([key]) => key.startsWith(args[0] + ':')).map(([key, quantity]) => {
          const productId = key.split(':')[1];
          return { product_id: productId, quantity, ...products.get(productId) };
        });
      },
      async run(...args) {
        calls.push({ sql, args });
        if (sql.startsWith('INSERT INTO cart_items')) cart.set(args[0] + ':' + args[1], args[2]);
        else if (sql.startsWith('DELETE FROM cart_items')) {
          if (args.length === 2) cart.delete(args.join(':'));
          else for (const key of cart.keys()) if (key.startsWith(args[0] + ':')) cart.delete(key);
        } else throw new Error('Unexpected mutation: ' + sql);
      }
    }; }
  };
  return { repo: createPostgresCartRepository(db), calls, cart, products };
}

test('cart repository requires transactions and returns an empty cart without invented prices', async () => {
  assert.throws(() => createPostgresCartRepository({ q() {} }), /transactions/);
  assert.deepEqual(await setup().repo.getCart('buyer'), { items: [], subtotal_paisa: 0, item_count: 0 });
});

test('PUT replaces quantity, locks the customer first, and never reserves stock', async () => {
  const h = setup();
  await h.repo.setItemQuantity('buyer', 'p1', '3');
  const result = await h.repo.setItemQuantity('buyer', 'p1', 2);
  assert.equal(h.cart.get('buyer:p1'), 2);
  assert.equal(result.subtotal_paisa, 198);
  assert.equal(result.item_count, 2);
  assert.equal(h.products.get('p1').stock, '10');
  assert.equal(h.calls[0].sql, 'BEGIN');
  assert.match(h.calls[1].sql, /FROM users.*FOR UPDATE/);
  assert.match(h.calls[2].sql, /FROM products.*FOR SHARE OF p/);
  assert.equal(h.calls.at(-1).sql, 'COMMIT');
  assert.ok(!h.calls.some(call => /UPDATE products|INSERT INTO orders/.test(call.sql)));
});

test('cart subtotals sum integer paisa and use sale prices only when valid', async () => {
  const h = setup();
  await h.repo.setItemQuantity('buyer', 'p1', 3);
  const result = await h.repo.setItemQuantity('buyer', 'p2', 2);
  assert.equal(result.subtotal_paisa, 701);
  assert.equal(result.item_count, 5);
  for (const discount of [0, 101, 999]) {
    h.products.get('p1').discount_paisa = discount;
    assert.equal((await h.repo.getCart('buyer')).items[0].unit_price_paisa, 101);
  }
});

test('invalid quantities and product IDs are rejected before a transaction can mutate the cart', async () => {
  const h = setup();
  for (const quantity of [undefined, null, true, false, '', ' ', [], {}, [2], '0x2', '2e0', '2.5', 1.5, -1, 1001, NaN, Infinity]) {
    await assert.rejects(h.repo.setItemQuantity('buyer', 'p1', quantity), error => error.status === 400);
  }
  for (const id of [undefined, null, {}, [], '', ' ', 'x'.repeat(161), 'p\u00001']) {
    await assert.rejects(h.repo.setItemQuantity('buyer', id, 1), error => error.status === 400);
  }
  assert.deepEqual(h.calls, []);
});

test('insufficient stock and unavailable products leave existing cart values unchanged', async () => {
  const h = setup();
  await h.repo.setItemQuantity('buyer', 'p1', 2);
  await assert.rejects(h.repo.setItemQuantity('buyer', 'p1', 11), error => error.status === 409);
  assert.equal(h.cart.get('buyer:p1'), 2);
  for (const [key, value] of [['active', 0], ['status', 'ARCHIVED'], ['seller_status', 'SUSPENDED']]) {
    const before = h.products.get('p1')[key];
    h.products.get('p1')[key] = value;
    await assert.rejects(h.repo.setItemQuantity('buyer', 'p1', 3), error => error.status === 404);
    assert.equal((await h.repo.getCart('buyer')).items[0].available, false);
    h.products.get('p1')[key] = before;
  }
});

test('saved unavailable lines remain visible and removable by zero quantity or DELETE', async () => {
  const h = setup();
  await h.repo.setItemQuantity('buyer', 'p1', 2);
  h.products.get('p1').stock = 1;
  assert.equal((await h.repo.getCart('buyer')).items[0].available, false);
  h.products.get('p1').active = 0;
  assert.deepEqual(await h.repo.setItemQuantity('buyer', 'p1', 0), { items: [], subtotal_paisa: 0, item_count: 0 });
  assert.deepEqual(await h.repo.removeItem('buyer', 'p1'), { items: [], subtotal_paisa: 0, item_count: 0 });
});

test('delete-one, clear-all and reads cannot affect another customers cart', async () => {
  const h = setup();
  await h.repo.setItemQuantity('a', 'p1', 1);
  await h.repo.setItemQuantity('b', 'p1', 2);
  assert.equal((await h.repo.getCart('a')).item_count, 1);
  await h.repo.removeItem('a', 'p1');
  assert.equal(h.cart.get('b:p1'), 2);
  await h.repo.clearCart('a');
  assert.equal(h.cart.get('b:p1'), 2);
  const deletes = h.calls.filter(call => call.sql.startsWith('DELETE'));
  assert.ok(deletes.every(call => call.sql.includes('WHERE user_id=?') && call.args[0] === 'a'));
});

test('fifty-line cap counts all stored lines, permits replacements, and refuses a new line', async () => {
  const h = setup({ count: String(MAX_CART_ITEMS) });
  h.cart.set('buyer:p1', 1);
  await h.repo.setItemQuantity('buyer', 'p1', 3);
  await assert.rejects(h.repo.setItemQuantity('buyer', 'p2', 1), error => error.status === 409);
  assert.equal(h.cart.get('buyer:p1'), 3);
  assert.equal(h.cart.has('buyer:p2'), false);
  const countQuery = h.calls.find(call => call.sql.includes('COUNT(*)'));
  assert.doesNotMatch(countQuery.sql, /ACTIVE|APPROVED/);
});

test('inactive or missing owners cannot mutate cart even if the HTTP session check raced', async () => {
  const h = setup({ owner: false });
  for (const op of [() => h.repo.setItemQuantity('buyer', 'p1', 1), () => h.repo.removeItem('buyer', 'p1'), () => h.repo.clearCart('buyer')]) {
    await assert.rejects(op(), error => error.status === 401);
  }
  assert.ok(!h.calls.some(call => /INSERT|DELETE|FROM products/.test(call.sql)));
});

test('overflowing or invalid persisted money fails closed and rolls back cart edits', async () => {
  const h = setup();
  h.products.get('p1').discount_paisa = null;
  h.products.get('p1').price_paisa = Number.MAX_SAFE_INTEGER;
  await assert.rejects(h.repo.setItemQuantity('buyer', 'p1', 2), RangeError);
  assert.equal(h.cart.size, 0);
  assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
  for (const value of ['9007199254740993', -1, null]) {
    h.products.get('p1').price_paisa = value;
    await assert.rejects(h.repo.setItemQuantity('buyer', 'p1', 1));
    assert.equal(h.cart.size, 0);
  }
});

test('cart routes preserve the customer contract and derive ownership only from the session', async () => {
  const routes = [], calls = [];
  const cartResult = { items: [{ product_id: 'p1', name_bn: 'চা', name_en: 'Tea', quantity: 3, stock: 10,
    image: null, available: true, unit_price_paisa: 101, line_total_paisa: 303, internal: 'private' }], subtotal_paisa: 303, item_count: 3 };
  const cartRepository = Object.fromEntries(['getCart', 'setItemQuantity', 'removeItem', 'clearCart'].map(name =>
    [name, async (...args) => { calls.push([name, ...args]); return cartResult; }]));
  registerPostgresCartRoutes((method, path, roles, handler) => routes.push({ method, path, roles, handler }), data => ({ data }), { cartRepository });
  assert.equal(routes.length, 4);
  for (const route of routes) {
    assert.deepEqual(route.roles, ['CUSTOMER']);
    const { data } = await route.handler({ user: { id: 'buyer' }, params: ['p1'], body: { productId: 'p1', quantity: 3, user_id: 'victim' } });
    assert.equal(data.subtotal_bdt, 3.03);
    assert.equal(data.items[0].unit_price_bdt, 1.01);
    assert.equal(data.items[0].line_total_bdt, 3.03);
    assert.equal(data.item_count, 3);
    assert.doesNotMatch(JSON.stringify(data), /private|paisa|victim/);
  }
  assert.deepEqual(calls, [['getCart', 'buyer'], ['setItemQuantity', 'buyer', 'p1', 3], ['removeItem', 'buyer', 'p1'], ['clearCart', 'buyer']]);
});
