import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, delivery } from './helpers.mjs';

const api = await startApi(4435);
const { request: R, login } = api;
test.after(() => api.stop());

test('storefront config drives shipping quote, checkout shipping, and admin updates', async () => {
  const initial = await R('/api/v1/storefront/config');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.data.dhaka_shipping_bdt, 60);
  assert.equal(initial.data.data.outside_shipping_bdt, 120);

  const admin = (await login('01700000001', 'Admin@12345')).data.token;
  const seller = (await login('01700000002', 'Seller@12345')).data.token;
  const customer = (await login('01700000003', 'Customer@12345')).data.token;

  // Non-admin cannot access admin storefront config
  assert.equal((await R('/api/v1/admin/storefront/config', { token: customer })).status, 403);
  assert.equal((await R('/api/v1/admin/storefront/config', { token: seller })).status, 403);

  // Admin updates shipping rates + promo banner
  const updated = await R('/api/v1/admin/storefront/config', {
    method: 'PUT',
    token: admin,
    body: {
      promo_banner_bn: 'ঈদ উৎসব: ২০০০৳+ অর্ডারে ফ্রি ডেলিভারি',
      dhaka_shipping_bdt: 75,
      outside_shipping_bdt: 140,
      free_shipping_over_bdt: 3000
    }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.data.dhaka_shipping_bdt, 75);
  assert.equal(updated.data.data.free_shipping_over_bdt, 3000);

  // Public config & shipping quote reflect updated values
  const publicCfg = await R('/api/v1/storefront/config');
  assert.equal(publicCfg.data.data.promo_banner_bn, 'ঈদ উৎসব: ২০০০৳+ অর্ডারে ফ্রি ডেলিভারি');

  const quoteDhaka = await R('/api/v1/shipping/quote?area=Dhaka&subtotal_bdt=500');
  assert.equal(quoteDhaka.data.data.shipping_bdt, 75);

  const quoteFree = await R('/api/v1/shipping/quote?area=Sylhet&subtotal_bdt=3500');
  assert.equal(quoteFree.data.data.shipping_bdt, 0);

  // Checkout computes shipping using updated config
  const catalog = await R('/api/v1/products?limit=10');
  const product = catalog.data.data.find(p => p.name_en === 'Wireless Earbuds');
  assert.ok(product);
  const checkoutRes = await R('/api/v1/checkout', {
    method: 'POST',
    token: customer,
    body: { delivery: delivery(), items: [{ productId: product.id, quantity: 1 }] }
  });
  assert.equal(checkoutRes.status, 201);
  assert.equal(checkoutRes.data.data.shipping_bdt, 75);

  // Seller analytics returns accurate order & unit counts
  const analytics = await R('/api/v1/seller/analytics', { token: seller });
  assert.equal(analytics.status, 200);
  assert.ok(analytics.data.data.total_units_sold >= 1);
  assert.ok(analytics.data.data.avg_order_value_bdt > 0);
  assert.ok(Array.isArray(analytics.data.data.top_products));

  // Admin period financial summary matches PostgreSQL reporting contract
  const todayDhaka = new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10);
  assert.equal((await R('/api/v1/admin/reports/summary?from=bad&to=' + todayDhaka, { token: admin })).status, 400);
  assert.equal((await R('/api/v1/admin/reports/summary?from=' + todayDhaka + '&to=' + todayDhaka, { token: seller })).status, 403);
  const summary = await R('/api/v1/admin/reports/summary?from=' + todayDhaka + '&to=' + todayDhaka, { token: admin });
  assert.equal(summary.status, 200);
  assert.equal(summary.data.data.period.time_zone, 'Asia/Dhaka');
  assert.ok(summary.data.data.orders.total >= 1);
  assert.ok(summary.data.data.sales.shipping !== null);
  assert.ok(summary.data.data.refunds !== null);

  const sellerMe = await R('/api/v1/auth/me', { token: seller });
  const sellerSummary = await R('/api/v1/admin/reports/summary?from=' + todayDhaka + '&to=' + todayDhaka + '&seller_id=' + encodeURIComponent(sellerMe.data.data.id), { token: admin });
  assert.equal(sellerSummary.status, 200);
  assert.equal(sellerSummary.data.data.sales.shipping, null);
  assert.equal(sellerSummary.data.data.refunds, null);
  assert.ok(sellerSummary.data.data.orders.total >= 1);

  // Seller single-product detail returns category_slug and brand_slug for editing
  const sellerDetail = await R('/api/v1/seller/products/' + encodeURIComponent(product.id), { token: seller });
  assert.equal(sellerDetail.status, 200);
  assert.equal(sellerDetail.data.data.category_slug, 'electronics');
  assert.ok(sellerDetail.data.data.brand_slug);
});
