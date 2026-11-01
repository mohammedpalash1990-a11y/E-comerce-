import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, delivery } from './helpers.mjs';

const api = await startApi(4418);
const { request: R, login } = api;
test.after(() => api.stop());

const state = {};
const prodByName = async name => (await R('/api/v1/products?q=' + encodeURIComponent(name))).data.data[0];
const stockOf = async name => (await prodByName(name)).stock;

test('setup: demo accounts log in', async () => {
  state.admin = (await login('01700000001', 'Admin@12345')).data.token;
  state.seller1 = (await login('seller@haat.test', 'Seller@12345')).data.token;
  state.demoCustomer = (await login('01700000003', 'Customer@12345')).data.token;
  assert.ok(state.admin && state.seller1 && state.demoCustomer);
  assert.equal((await login('01700000001', 'wrong')).status, 401);
});

test('customer: registration validation, duplicates, login by phone/email', async () => {
  const good = { name: 'Rahim Uddin', phone: '01812345678', email: 'rahim@example.com', password: 'Passw0rd!x', confirm_password: 'Passw0rd!x', address: 'Mirpur 10', area: 'Dhaka' };
  assert.equal((await R('/api/v1/auth/register', { method: 'POST', body: { ...good, confirm_password: 'nope1234' } })).status, 400);
  assert.equal((await R('/api/v1/auth/register', { method: 'POST', body: { ...good, password: 'short', confirm_password: 'short' } })).status, 400);
  assert.equal((await R('/api/v1/auth/register', { method: 'POST', body: { ...good, phone: '123' } })).status, 400);
  const reg = await R('/api/v1/auth/register', { method: 'POST', body: good });
  assert.equal(reg.status, 201); assert.equal(reg.data.data.role, 'CUSTOMER');
  state.custPhoneCode = reg.data.dev_verification_code;
  assert.equal((await R('/api/v1/auth/register', { method: 'POST', body: { ...good, email: 'other@example.com' } })).status, 409, 'duplicate phone');
  assert.equal((await R('/api/v1/auth/register', { method: 'POST', body: { ...good, phone: '01912345678', email: 'RAHIM@example.com' } })).status, 409, 'duplicate email (case-insensitive)');
  const byPhone = await login('01812345678', 'Passw0rd!x'), byEmail = await login('rahim@example.com', 'Passw0rd!x');
  assert.equal(byPhone.status, 200); assert.equal(byEmail.status, 200);
  state.cust = byPhone.data.token;
  assert.equal((await login('01812345678', 'Passw0rd!x', { portal: 'ADMIN' })).status, 403, 'customer cannot use admin portal');
  const me = await R('/api/v1/auth/me', { token: state.cust });
  assert.equal(me.data.data.phone_verified, false);
  assert.equal((await R('/api/v1/auth/verify', { method: 'POST', token: state.cust, body: { purpose: 'PHONE', code: '000000' } })).status, 400);
  assert.equal((await R('/api/v1/auth/verify', { method: 'POST', token: state.cust, body: { purpose: 'PHONE', code: state.custPhoneCode } })).status, 200);
  assert.equal((await R('/api/v1/auth/me', { token: state.cust })).data.data.phone_verified, true);
});

test('customer: profile, addresses, wishlist, password change, logout, forgot/reset', async () => {
  const upd = await R('/api/v1/me', { method: 'PATCH', token: state.cust, body: { name: 'Rahim U.' } });
  assert.equal(upd.data.data.name, 'Rahim U.');
  const addr = await R('/api/v1/customer/addresses', { method: 'POST', token: state.cust, body: { label: 'Office', name: 'Rahim', phone: '01812345678', address: 'Gulshan 1', area: 'Dhaka', is_default: true } });
  assert.equal(addr.status, 201);
  assert.equal((await R('/api/v1/customer/addresses', { token: state.cust })).data.data.length, 2);
  assert.equal((await R('/api/v1/customer/addresses/' + addr.data.data.id, { method: 'DELETE', token: state.cust })).status, 200);
  const lamp = await prodByName('Desk Lamp');
  assert.equal((await R('/api/v1/customer/wishlist', { method: 'POST', token: state.cust, body: { productId: lamp.id } })).status, 201);
  assert.equal((await R('/api/v1/customer/wishlist', { token: state.cust })).data.data.length, 1);
  assert.equal((await R('/api/v1/customer/wishlist/' + lamp.id, { method: 'DELETE', token: state.cust })).status, 200);

  assert.equal((await R('/api/v1/auth/change-password', { method: 'POST', token: state.cust, body: { current_password: 'bad', new_password: 'NewPassw0rd' } })).status, 403);
  assert.equal((await R('/api/v1/auth/change-password', { method: 'POST', token: state.cust, body: { current_password: 'Passw0rd!x', new_password: 'NewPassw0rd' } })).status, 200);
  const old = (await login('01812345678', 'Passw0rd!x')); assert.equal(old.status, 401);
  const forgot = await R('/api/v1/auth/forgot-password', { method: 'POST', body: { identifier: 'rahim@example.com' } });
  assert.equal((await R('/api/v1/auth/reset-password', { method: 'POST', body: { identifier: 'rahim@example.com', code: '111111', new_password: 'ResetPassw0rd' } })).status, 400);
  assert.equal((await R('/api/v1/auth/reset-password', { method: 'POST', body: { identifier: 'rahim@example.com', code: forgot.data.data.dev_code, new_password: 'ResetPassw0rd' } })).status, 200);
  assert.equal((await R('/api/v1/auth/me', { token: state.cust })).status, 401, 'reset invalidates sessions');
  assert.equal((await R('/api/v1/auth/reset-password', { method: 'POST', body: { identifier: 'rahim@example.com', code: forgot.data.data.dev_code, new_password: 'AnotherPassw0rd' } })).status, 400, 'code is single-use');
  const again = await login('01812345678', 'ResetPassw0rd'); state.cust = again.data.token;
  assert.equal((await R('/api/v1/auth/logout', { method: 'POST', token: state.cust })).status, 200);
  assert.equal((await R('/api/v1/customer/orders', { token: state.cust })).status, 401, 'logged-out token is dead');
  state.cust = (await login('01812345678', 'ResetPassw0rd')).data.token;
});

test('seller: registration, pending approval gates storefront, edit re-approval', async () => {
  const body = { name: 'Karim', phone: '01555555555', email: 'karim@shop.com', password: 'Seller2Pass1', confirm_password: 'Seller2Pass1', shop_name: 'Karim Mugs', shop_address: 'Chattogram', business_info: 'Mug retailer', kyc_nid: '1987654321012' };
  assert.equal((await R('/api/v1/auth/register-seller', { method: 'POST', body: { ...body, kyc_nid: 'abc' } })).status, 400);
  const reg = await R('/api/v1/auth/register-seller', { method: 'POST', body });
  assert.equal(reg.status, 201); assert.equal(reg.data.data.status, 'PENDING');
  assert.equal((await R('/api/v1/auth/register-seller', { method: 'POST', body: { ...body, phone: '01666666666', email: 'x@y.com' } })).status, 409, 'duplicate shop name');
  state.seller2 = (await login('01555555555', 'Seller2Pass1', { portal: 'SELLER' })).data.token;
  const created = await R('/api/v1/seller/products', { method: 'POST', token: state.seller2, body: { name_bn: 'মগ', name_en: 'Karim Mug', category_slug: 'home', price_bdt: 500, discount_price_bdt: 450, stock: 10, description: 'Nice mug', sku: 'MUG-1', variants: [{ label: 'Blue', sku: 'MUG-B' }], images: ['https://example.com/mug.jpg'] } });
  assert.equal(created.status, 201); state.mugId = created.data.data.id;
  assert.equal((await R('/api/v1/seller/products', { method: 'POST', token: state.seller2, body: { name_bn: 'x', name_en: 'x', category_slug: 'home', price_bdt: 5, stock: 1, images: ['javascript:alert(1)'] } })).status, 400, 'unsafe image rejected');
  const dash0 = await R('/api/v1/seller/dashboard', { token: state.seller2 });
  assert.equal(dash0.data.data.products.pending, 1);
  assert.equal((await R('/api/v1/admin/products/' + state.mugId + '/approve', { method: 'POST', token: state.admin })).status, 409, 'seller not approved yet');
  assert.equal((await R('/api/v1/admin/sellers/' + reg.data.data.id + '/approve', { method: 'POST', token: state.admin, body: {} })).status, 200);
  assert.equal((await R('/api/v1/admin/products/' + state.mugId + '/approve', { method: 'POST', token: state.admin })).status, 200);
  const pub = await prodByName('Karim Mug');
  assert.equal(pub.sale_price_bdt, 450); assert.equal(pub.price_bdt, 500);
  const detail = await R('/api/v1/products/' + state.mugId);
  assert.equal(detail.data.data.images[0], 'https://example.com/mug.jpg'); assert.equal(detail.data.data.variants[0].label, 'Blue'); assert.equal(detail.data.data.seller_shop, 'Karim Mugs');
  // editing a live product sends it back for approval and hides it
  assert.equal((await R('/api/v1/seller/products/' + state.mugId, { method: 'PUT', token: state.seller2, body: { price_bdt: 600, discount_price_bdt: null } })).data.data.status, 'PENDING_REVIEW');
  assert.equal(await prodByName('Karim Mug'), undefined);
  assert.equal((await R('/api/v1/admin/products/' + state.mugId + '/approve', { method: 'POST', token: state.admin })).status, 200);
  assert.equal((await prodByName('Karim Mug')).sale_price_bdt, 600);
  // seller cannot touch another seller's product
  const demo = await prodByName('Desk Lamp');
  assert.equal((await R('/api/v1/seller/products/' + demo.id, { method: 'PUT', token: state.seller2, body: { price_bdt: 1 } })).status, 404);
  assert.equal((await R('/api/v1/seller/products/' + demo.id, { method: 'DELETE', token: state.seller2 })).status, 404);
});

test('catalog: search, suggestions, sorting, price filter, category', async () => {
  assert.ok((await R('/api/v1/products/suggest?q=Wire')).data.data.length >= 1);
  const asc = (await R('/api/v1/products?sort=price_asc')).data.data.map(p => p.sale_price_bdt);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  const desc = (await R('/api/v1/products?sort=price_desc')).data.data.map(p => p.sale_price_bdt);
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
  const ranged = (await R('/api/v1/products?min_price=900&max_price=1300')).data.data;
  assert.ok(ranged.length >= 2 && ranged.every(p => p.sale_price_bdt >= 900 && p.sale_price_bdt <= 1300));
  assert.ok((await R('/api/v1/products?category=fashion')).data.data.every(p => p.category_slug === 'fashion'));
});

test('customer cart sync: PUT replaces quantity, validates stock, removes zero and preserves cart on rejected checkout', async () => {
  const lamp = await prodByName('Desk Lamp');
  const initialStock = lamp.stock;
  assert.equal((await R('/api/v1/customer/cart', { method: 'PUT', token: state.cust, body: { productId: lamp.id, quantity: 1 } })).status, 200);
  assert.equal((await R('/api/v1/customer/cart', { method: 'PUT', token: state.cust, body: { productId: lamp.id, quantity: 2 } })).status, 200);
  let cart = (await R('/api/v1/customer/cart', { token: state.cust })).data.data;
  assert.equal(cart.items.find(x => x.product_id === lamp.id).quantity, 2, 'PUT is replacement, not additive');
  assert.equal((await R('/api/v1/customer/cart', { method: 'PUT', token: state.cust, body: { productId: lamp.id, quantity: 1.5 } })).status, 400);
  assert.equal((await R('/api/v1/customer/cart', { method: 'PUT', token: state.cust, body: { productId: lamp.id, quantity: initialStock + 1 } })).status, 409);
  cart = (await R('/api/v1/customer/cart', { token: state.cust })).data.data;
  assert.equal(cart.items.find(x => x.product_id === lamp.id).quantity, 2, 'rejected update leaves previous quantity intact');
  const rejected = await R('/api/v1/checkout', { method: 'POST', token: state.cust, body: { delivery: delivery(), coupon_code: 'NOT-A-REAL-COUPON' } });
  assert.equal(rejected.status, 400, 'invalid coupon rejects checkout');
  assert.equal(await stockOf('Desk Lamp'), initialStock, 'rejected checkout does not reserve stock');
  cart = (await R('/api/v1/customer/cart', { token: state.cust })).data.data;
  assert.equal(cart.items.find(x => x.product_id === lamp.id).quantity, 2, 'rejected checkout preserves cart');
  assert.equal((await R('/api/v1/customer/cart', { method: 'PUT', token: state.cust, body: { productId: lamp.id, quantity: 0 } })).status, 200);
  assert.equal((await R('/api/v1/customer/cart', { token: state.cust })).data.data.items.length, 0, 'zero quantity removes item');
});

test('checkout rejects unsupported payment methods without reserving stock or creating an order', async () => {
  const lamp = await prodByName('Desk Lamp');
  const before = lamp.stock;
  const response = await R('/api/v1/checkout', { method: 'POST', token: state.cust, body: { delivery: delivery(), items: [{ productId: lamp.id, quantity: 1 }], payment_method: 'BITCOIN' } });
  assert.equal(response.status, 400);
  assert.equal(await stockOf('Desk Lamp'), before);
  const orders = (await R('/api/v1/customer/orders', { token: state.cust })).data.data;
  assert.equal(orders.some(o => o.id === response.data?.data?.id), false);
});

test('multi-seller cart, coupon, COD checkout, seller isolation, fulfilment, finance', async () => {
  const earbuds = await prodByName('Wireless Earbuds'), mug = await prodByName('Karim Mug');
  assert.equal((await R('/api/v1/admin/coupons', { method: 'POST', token: state.admin, body: { code: 'save10', type: 'PERCENT', value: 10, min_order_bdt: 1000 } })).status, 201);
  assert.equal((await R('/api/v1/customer/cart', { method: 'PUT', token: state.cust, body: { productId: mug.id, quantity: 9999 } })).status, 400);
  assert.equal((await R('/api/v1/customer/cart', { method: 'PUT', token: state.cust, body: { productId: mug.id, quantity: 11 } })).status, 409, 'more than stock');
  await R('/api/v1/customer/cart', { method: 'PUT', token: state.cust, body: { productId: earbuds.id, quantity: 1 } });
  const cart = await R('/api/v1/customer/cart', { method: 'PUT', token: state.cust, body: { productId: mug.id, quantity: 2 } });
  assert.equal(cart.data.data.subtotal_bdt, 1890 + 1200);
  assert.equal((await R('/api/v1/coupons/validate', { method: 'POST', token: state.cust, body: { code: 'NOPE', subtotal_bdt: 3090 } })).status, 400);
  const order = await R('/api/v1/checkout', { method: 'POST', token: state.cust, body: { delivery: delivery('Dhaka'), coupon_code: 'SAVE10' } });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  assert.equal(order.data.data.subtotal_bdt, 3090); assert.equal(order.data.data.discount_bdt, 309); assert.equal(order.data.data.shipping_bdt, 60); assert.equal(order.data.data.total_bdt, 2841);
  assert.equal((await R('/api/v1/customer/cart', { token: state.cust })).data.data.items.length, 0, 'cart cleared');
  state.multi = order.data.data.id;
  const detail = await R('/api/v1/customer/orders/' + state.multi, { token: state.cust });
  assert.equal(detail.data.data.suborders.length, 2, 'one suborder per seller');
  // seller isolation
  const s1 = (await R('/api/v1/seller/orders', { token: state.seller1 })).data.data, s2 = (await R('/api/v1/seller/orders', { token: state.seller2 })).data.data;
  const mine1 = s1.find(o => o.items.some(i => i.name_bn === 'ওয়্যারলেস ইয়ারবাড')), mine2 = s2.find(o => o.items.some(i => i.name_bn === 'মগ'));
  assert.ok(mine1 && mine2);
  assert.equal(mine1.items.length, 1); assert.equal(mine2.items.length, 1);
  assert.equal(mine1.commission_bdt, 151.2); assert.equal(mine2.subtotal_bdt, 1200); assert.equal(mine2.commission_bdt, 96); assert.equal(mine2.net_bdt, 1104);
  assert.equal((await R('/api/v1/seller/orders/' + mine1.id, { token: state.seller2 })).status, 404, 'seller2 cannot read seller1 order');
  assert.equal((await R('/api/v1/seller/orders/' + mine1.id + '/status', { method: 'POST', token: state.seller2, body: { status: 'PROCESSING' } })).status, 404);
  // fulfilment of seller2 part, courier booking
  for (const st of ['PROCESSING']) assert.equal((await R('/api/v1/seller/orders/' + mine2.id + '/status', { method: 'POST', token: state.seller2, body: { status: st } })).status, 200);
  assert.equal((await R('/api/v1/seller/orders/' + mine2.id + '/courier', { method: 'POST', token: state.seller2, body: { provider: 'FEDEX' } })).status, 400);
  const booked = await R('/api/v1/seller/orders/' + mine2.id + '/courier', { method: 'POST', token: state.seller2, body: { provider: 'STEADFAST' } });
  assert.equal(booked.status, 201); assert.match(booked.data.data.tracking_id, /^ST-/);
  assert.equal((await R('/api/v1/seller/orders/' + mine2.id + '/courier', { method: 'POST', token: state.seller2, body: { provider: 'PATHAO' } })).status, 409, 'no double booking');
  assert.equal((await R('/api/v1/seller/orders/' + mine2.id + '/status', { method: 'POST', token: state.seller2, body: { status: 'SHIPPED' } })).data.data.parent_status, 'SHIPPED');
  const sh = (await R('/api/v1/seller/orders/' + mine2.id, { token: state.seller2 })).data.data.shipment;
  assert.equal((await R('/api/v1/seller/shipments/' + sh.id + '/status', { method: 'POST', token: state.seller2, body: { status: 'DELIVERED' } })).status, 200);
  const track = await R('/api/v1/customer/orders/' + state.multi + '/tracking', { token: state.cust });
  assert.ok(track.data.data.events.length >= 4); assert.equal(track.data.data.shipments[0].status, 'DELIVERED');
  // balances: pending for seller1, available for seller2
  const f2 = (await R('/api/v1/seller/finance', { token: state.seller2 })).data.data;
  assert.equal(f2.net_earnings_bdt, 1104); assert.equal(f2.available_balance_bdt, 1104); assert.equal(f2.commission_bdt, 96); assert.equal(f2.total_sales_bdt, 1200);
  const f1 = (await R('/api/v1/seller/finance', { token: state.seller1 })).data.data;
  assert.equal(f1.available_balance_bdt, 0); assert.ok(f1.pending_balance_bdt > 1700);
  // payouts
  assert.equal((await R('/api/v1/seller/payouts', { method: 'POST', token: state.seller2, body: { amount_bdt: 5000, method: 'BKASH', account: '01555555555' } })).status, 409, 'cannot exceed available');
  const po = await R('/api/v1/seller/payouts', { method: 'POST', token: state.seller2, body: { amount_bdt: 1000, method: 'BKASH', account: '01555555555' } });
  assert.equal(po.status, 201);
  assert.equal((await R('/api/v1/seller/payouts', { method: 'POST', token: state.seller2, body: { amount_bdt: 200, method: 'BKASH', account: '01555555555' } })).status, 409, 'reserved amount cannot be requested twice');
  assert.equal((await R('/api/v1/admin/payouts/' + po.data.data.id + '/approve', { method: 'POST', token: state.seller2 })).status, 403);
  assert.equal((await R('/api/v1/admin/payouts/' + po.data.data.id + '/approve', { method: 'POST', token: state.admin, body: {} })).status, 200);
  assert.equal((await R('/api/v1/admin/payouts/' + po.data.data.id + '/approve', { method: 'POST', token: state.admin, body: {} })).status, 404, 'cannot approve twice');
  const f2b = (await R('/api/v1/seller/finance', { token: state.seller2 })).data.data;
  assert.equal(f2b.available_balance_bdt, 104); assert.equal(f2b.paid_out_bdt, 1000);
  // seller1 completes and parent becomes DELIVERED (COD paid)
  for (const st of ['PROCESSING', 'SHIPPED', 'DELIVERED']) assert.equal((await R('/api/v1/seller/orders/' + mine1.id + '/status', { method: 'POST', token: state.seller1, body: { status: st } })).status, 200);
  const done = (await R('/api/v1/customer/orders/' + state.multi, { token: state.cust })).data.data;
  assert.equal(done.status, 'DELIVERED'); assert.equal(done.payment.status, 'PAID');
  const txs = (await R('/api/v1/admin/finance/transactions?kind=ORDER_PAYMENT', { token: state.admin })).data.data;
  assert.equal(txs.filter(t => t.order_id === state.multi).length, 1);
  // review only after delivery
  assert.equal((await R('/api/v1/customer/products/' + earbuds.id + '/reviews', { method: 'POST', token: state.cust, body: { rating: 5, comment: 'দারুণ' } })).status, 201);
  assert.equal((await R('/api/v1/customer/products/' + (await prodByName('Desk Lamp')).id + '/reviews', { method: 'POST', token: state.cust, body: { rating: 5 } })).status, 403);
});

test('online payment: sandbox flow, failure, retry, replay protection, signature, refund & reversal', async () => {
  const lamp = await prodByName('Desk Lamp'); const before = lamp.stock;
  const o = await R('/api/v1/checkout', { method: 'POST', token: state.cust, body: { delivery: delivery('Sylhet'), items: [{ productId: lamp.id, quantity: 2 }], payment_method: 'BKASH' } });
  assert.equal(o.status, 201); assert.equal(o.data.data.status, 'AWAITING_PAYMENT'); assert.equal(o.data.data.shipping_bdt, 120); assert.equal(o.data.data.total_bdt, 2020);
  state.online = o.data.data;
  assert.equal(await stockOf('Desk Lamp'), before - 2, 'stock reserved');
  assert.equal((await R('/api/v1/seller/orders', { token: state.seller1 })).data.data.some(x => x.items.some(i => i.name_bn === 'ডেস্ক ল্যাম্প')), false, 'seller does not see unpaid order');
  // frontend-claimed success is meaningless: forged callback rejected
  const txn = (await R('/api/v1/admin/orders/' + state.online.id, { token: state.admin })).data.data.payments.find(p => p.status === 'INITIATED').gateway_txn_id;
  const forged = await R('/api/v1/payments/callback/bkash', { method: 'POST', body: { gateway_txn_id: txn, amount_bdt: 2020, status: 'SUCCESS', signature: 'deadbeef' } });
  assert.equal(forged.status, 401);
  assert.equal((await R('/api/v1/customer/orders/' + state.online.id, { token: state.cust })).data.data.payment.status, 'PENDING');
  // failed payment then retry
  const failed = await R('/api/v1/payments/sandbox/' + state.online.payment.payment_id + '/simulate', { method: 'POST', token: state.cust, body: { outcome: 'fail' } });
  assert.equal(failed.data.data.status, 'FAILED');
  assert.equal((await R('/api/v1/payments/' + state.online.payment.payment_id + '/status', { token: state.cust })).data.data.status, 'FAILED');
  const retry = await R('/api/v1/customer/orders/' + state.online.id + '/pay', { method: 'POST', token: state.cust, body: { method: 'NAGAD' } });
  assert.equal(retry.status, 200);
  assert.equal((await R('/api/v1/payments/sandbox/' + retry.data.data.payment_id + '/simulate', { method: 'POST', token: state.demoCustomer, body: {} })).status, 404, 'other customer cannot pay');
  const paid = await R('/api/v1/payments/sandbox/' + retry.data.data.payment_id + '/simulate', { method: 'POST', token: state.cust, body: {} });
  assert.equal(paid.data.data.status, 'PAID'); assert.equal(paid.data.data.duplicate, false);
  const od = (await R('/api/v1/customer/orders/' + state.online.id, { token: state.cust })).data.data;
  assert.equal(od.status, 'CONFIRMED'); assert.equal(od.payment.status, 'PAID');
  // replayed webhook (valid signature) must not create a second transaction
  const { signCallback } = await import('../apps/api/src/gateways.mjs').catch(() => ({}));
  const pay2 = (await R('/api/v1/admin/orders/' + state.online.id, { token: state.admin })).data.data.payments.find(p => p.status === 'PAID');
  process.env.PAYMENT_WEBHOOK_SECRET ??= 'dev-sandbox-secret';
  const { createHmac } = await import('node:crypto');
  const sig = createHmac('sha256', 'dev-sandbox-secret').update([pay2.gateway_txn_id, pay2.amount_paisa, 'SUCCESS'].join('|')).digest('hex');
  const replay = await R('/api/v1/payments/callback/nagad', { method: 'POST', body: { gateway_txn_id: pay2.gateway_txn_id, amount_bdt: 2020, status: 'SUCCESS', signature: sig } });
  assert.equal(replay.status, 200); assert.equal(replay.data.data.duplicate, true);
  const wrongAmt = createHmac('sha256', 'dev-sandbox-secret').update([pay2.gateway_txn_id, 100, 'SUCCESS'].join('|')).digest('hex');
  assert.equal((await R('/api/v1/payments/callback/nagad', { method: 'POST', body: { gateway_txn_id: pay2.gateway_txn_id, amount_bdt: 1, status: 'SUCCESS', signature: wrongAmt } })).status, 400, 'amount mismatch');
  const txs = (await R('/api/v1/admin/finance/transactions?kind=ORDER_PAYMENT', { token: state.admin })).data.data.filter(t => t.order_id === state.online.id);
  assert.equal(txs.length, 1, 'duplicate payment created no duplicate transaction');
  assert.equal((await R('/api/v1/seller/orders', { token: state.seller1 })).data.data.some(x => x.items.some(i => i.name_bn === 'ডেস্ক ল্যাম্প')), true, 'seller now sees paid order');
  // deliver, then partial refund with seller reversal
  const so = (await R('/api/v1/seller/orders', { token: state.seller1 })).data.data.find(x => x.items.some(i => i.name_bn === 'ডেস্ক ল্যাম্প'));
  for (const st of ['PROCESSING', 'SHIPPED', 'DELIVERED']) await R('/api/v1/seller/orders/' + so.id + '/status', { method: 'POST', token: state.seller1, body: { status: st } });
  const f0 = (await R('/api/v1/seller/finance', { token: state.seller1 })).data.data.net_earnings_bdt;
  assert.equal((await R('/api/v1/admin/orders/' + state.online.id + '/refund', { method: 'POST', token: state.admin, body: { amount_bdt: 99999, reason: 'x' } })).status, 409);
  assert.equal((await R('/api/v1/admin/orders/' + state.online.id + '/refund', { method: 'POST', token: state.admin, body: { amount_bdt: 1010, reason: 'ক্ষতিগ্রস্ত পণ্য' } })).status, 201);
  const f1 = (await R('/api/v1/seller/finance', { token: state.seller1 })).data.data.net_earnings_bdt;
  assert.ok(f1 < f0, 'seller earnings reduced by proportional reversal');
  assert.equal((await R('/api/v1/customer/orders/' + state.online.id, { token: state.cust })).data.data.payment.status, 'PARTIALLY_REFUNDED');
});

test('cancellation: customer & admin cancel restore stock exactly once, paid cancel raises refund', async () => {
  const lamp = await prodByName('Desk Lamp'); const base = lamp.stock;
  const mk = async (extra = {}) => (await R('/api/v1/checkout', { method: 'POST', token: state.cust, body: { delivery: delivery(), items: [{ productId: lamp.id, quantity: 3 }], ...extra } })).data.data;
  const a = await mk(); assert.equal(await stockOf('Desk Lamp'), base - 3);
  assert.equal((await R('/api/v1/customer/orders/' + a.id + '/cancel', { method: 'POST', token: state.cust, body: {} })).data.data.status, 'CANCELLED');
  assert.equal(await stockOf('Desk Lamp'), base);
  assert.equal((await R('/api/v1/customer/orders/' + a.id + '/cancel', { method: 'POST', token: state.cust, body: {} })).status, 409);
  assert.equal((await R('/api/v1/admin/orders/' + a.id + '/status', { method: 'POST', token: state.admin, body: { status: 'CANCELLED' } })).status, 409);
  assert.equal(await stockOf('Desk Lamp'), base, 'no second restore');
  // customer cannot cancel once processing
  const b = await mk(); await R('/api/v1/admin/orders/' + b.id + '/status', { method: 'POST', token: state.admin, body: { status: 'PROCESSING' } });
  assert.equal((await R('/api/v1/customer/orders/' + b.id + '/cancel', { method: 'POST', token: state.cust, body: {} })).status, 409);
  assert.equal((await R('/api/v1/admin/orders/' + b.id + '/status', { method: 'POST', token: state.admin, body: { status: 'CANCELLED' } })).data.data.status, 'CANCELLED');
  assert.equal(await stockOf('Desk Lamp'), base);
  // paid online order cancelled by admin -> refund request, approved once
  const c = await mk({ payment_method: 'SSLCOMMERZ' });
  await R('/api/v1/payments/sandbox/' + c.payment.payment_id + '/simulate', { method: 'POST', token: state.cust, body: {} });
  await R('/api/v1/admin/orders/' + c.id + '/status', { method: 'POST', token: state.admin, body: { status: 'CANCELLED' } });
  assert.equal(await stockOf('Desk Lamp'), base);
  const refunds = (await R('/api/v1/admin/refunds', { token: state.admin })).data.data.filter(r => r.order_id === c.id);
  assert.equal(refunds.length, 1); assert.equal(refunds[0].amount_bdt, c.total_bdt);
  assert.equal((await R('/api/v1/admin/refunds/' + refunds[0].id + '/approve', { method: 'POST', token: state.admin })).status, 200);
  assert.equal((await R('/api/v1/admin/refunds/' + refunds[0].id + '/approve', { method: 'POST', token: state.admin })).status, 404);
  assert.equal((await R('/api/v1/customer/orders/' + c.id, { token: state.cust })).data.data.payment.status, 'REFUNDED');
});

test('admin: dashboard, customers, sellers, shipping charge, notes, finance, audit trail', async () => {
  const d = (await R('/api/v1/admin/dashboard', { token: state.admin })).data.data;
  assert.ok(d.total_customers >= 2 && d.total_sellers === 2 && d.cancelled_orders >= 3 && d.platform_commission_bdt > 0 && d.total_revenue_bdt > 0);
  const found = (await R('/api/v1/admin/customers?q=0181234', { token: state.admin })).data.data; assert.equal(found.length, 1);
  const cid = found[0].id;
  assert.equal((await R('/api/v1/admin/customers/' + cid, { token: state.admin })).data.data.addresses.length, 1);
  assert.ok((await R('/api/v1/admin/customers/' + cid + '/orders', { token: state.admin })).data.data.length >= 4);
  assert.equal((await R('/api/v1/admin/customers/' + cid, { method: 'PUT', token: state.admin, body: { name: 'Rahim Edited' } })).data.data.name, 'Rahim Edited');
  const s = (await R('/api/v1/admin/sellers?status=APPROVED', { token: state.admin })).data.data; assert.equal(s.length, 2);
  assert.equal((await R('/api/v1/admin/sellers/' + s[0].id + '/commission', { method: 'PATCH', token: state.admin, body: { commission_bps: 99999 } })).status, 400);
  // order note + shipping charge change
  const lamp = await prodByName('Desk Lamp');
  const o = (await R('/api/v1/checkout', { method: 'POST', token: state.cust, body: { delivery: delivery(), items: [{ productId: lamp.id, quantity: 1 }] } })).data.data;
  assert.equal((await R('/api/v1/admin/orders/' + o.id + '/note', { method: 'POST', token: state.admin, body: { note: 'Call first' } })).status, 200);
  const ship = await R('/api/v1/admin/orders/' + o.id + '/shipping', { method: 'POST', token: state.admin, body: { shipping_bdt: 80 } });
  assert.equal(ship.data.data.total_bdt, 950 + 80);
  assert.equal((await R('/api/v1/admin/orders/' + o.id, { token: state.admin })).data.data.admin_note, 'Call first');
  const fin = (await R('/api/v1/admin/finance/summary', { token: state.admin })).data.data;
  assert.ok(fin.gross_sales_bdt > 0 && fin.refunds_bdt > 0 && fin.net_sales_bdt === fin.gross_sales_bdt - fin.refunds_bdt && fin.paid_out_bdt === 1000);
  assert.ok((await R('/api/v1/admin/finance/report', { token: state.admin })).data.data.length >= 1);
  const logs = (await R('/api/v1/admin/audit-logs?limit=500', { token: state.admin })).data.data.map(l => l.action);
  for (const a of ['CHECKOUT', 'PAYOUT_APPROVED', 'SELLER_APPROVED', 'PRODUCT_ACTIVE', 'REFUND_APPROVED', 'PAYMENT_PAID']) assert.ok(logs.includes(a), 'audit has ' + a);
  // category/brand management
  assert.equal((await R('/api/v1/admin/categories', { method: 'POST', token: state.admin, body: { name_bn: 'খেলনা', name_en: 'Toys' } })).status, 201);
  assert.equal((await R('/api/v1/admin/brands', { method: 'POST', token: state.admin, body: { name: 'Acme' } })).status, 201);
  // suspend customer -> login blocked, live session dead
  assert.equal((await R('/api/v1/admin/customers/' + cid + '/suspend', { method: 'POST', token: state.admin })).status, 200);
  assert.equal((await R('/api/v1/customer/orders', { token: state.cust })).status, 401);
  assert.equal((await login('01812345678', 'ResetPassw0rd')).status, 403);
  await R('/api/v1/admin/customers/' + cid + '/activate', { method: 'POST', token: state.admin });
  assert.equal((await login('01812345678', 'ResetPassw0rd')).status, 200);
  // suspending a seller hides their products
  const sid = s.find(x => x.shop_name === 'Karim Mugs').id;
  await R('/api/v1/admin/sellers/' + sid + '/suspend', { method: 'POST', token: state.admin, body: { reason: 'test' } });
  assert.equal(await prodByName('Karim Mug'), undefined);
  assert.equal((await R('/api/v1/seller/orders', { token: state.seller2 })).status, 401, 'suspended seller session dead');
});

test('security: roles, isolation, unauthenticated, headers, CORS, malformed input', async () => {
  const cust = (await login('01700000003', 'Customer@12345')).data.token, other = (await login('01812345678', 'ResetPassw0rd')).data.token;
  for (const p of ['/api/v1/admin/dashboard', '/api/v1/admin/customers', '/api/v1/admin/orders', '/api/v1/admin/finance/summary', '/api/v1/admin/audit-logs']) {
    assert.equal((await R(p)).status, 401, p + ' unauth');
    assert.equal((await R(p, { token: cust })).status, 403, p + ' customer');
    assert.equal((await R(p, { token: state.seller1 })).status, 403, p + ' seller');
  }
  for (const p of ['/api/v1/seller/orders', '/api/v1/seller/dashboard', '/api/v1/seller/finance']) { assert.equal((await R(p, { token: cust })).status, 403); assert.equal((await R(p)).status, 401); }
  for (const p of ['/api/v1/customer/orders', '/api/v1/customer/cart', '/api/v1/customer/addresses']) { assert.equal((await R(p, { token: state.seller1 })).status, 403); assert.equal((await R(p)).status, 401); }
  const theirs = (await R('/api/v1/customer/orders', { token: other })).data.data[0];
  assert.equal((await R('/api/v1/customer/orders/' + theirs.id, { token: cust })).status, 404, 'customer cannot read another customer order');
  assert.equal((await R('/api/v1/customer/orders/' + theirs.id + '/cancel', { method: 'POST', token: cust, body: {} })).status, 404);
  assert.equal((await R('/api/v1/auth/me', { token: 'x'.repeat(64) })).status, 401);
  // SQL injection attempts are inert
  const inj = await R("/api/v1/products?q=" + encodeURIComponent("' OR 1=1; DROP TABLE products;--")); assert.equal(inj.status, 200); assert.equal(inj.data.data.length, 0);
  assert.equal((await login("' OR '1'='1", 'x')).status, 401);
  assert.ok((await R('/api/v1/products')).data.data.length >= 3);
  // headers + CORS
  const h = await R('/health', { headers: { origin: 'http://localhost:3000' } });
  assert.equal(h.headers.get('access-control-allow-origin'), 'http://localhost:3000'); assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  const evil = await R('/health', { headers: { origin: 'https://evil.example' } }); assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(api.base + '/api/v1/products', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }); assert.equal(pre.status, 403);
  // malformed JSON / oversized bodies / unknown route / method
  const bad = await fetch(api.base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }); assert.equal(bad.status, 400);
  const big = await fetch(api.base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: 'x'.repeat(300000) }) }); assert.equal(big.status, 413);
  assert.equal((await R('/api/v1/nope')).status, 404); assert.equal((await R('/api/v1/products', { method: 'DELETE', token: cust })).status, 405);
  // stored passwords are hashed, never returned
  const me = JSON.stringify((await R('/api/v1/auth/me', { token: cust })).data); assert.ok(!/password|scrypt/i.test(me));
});
