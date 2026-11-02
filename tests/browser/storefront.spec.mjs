import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('homepage renders the canonical Bangla-first storefront and all demo products', async ({ page }) => {
  await expect(page).toHaveTitle(/HAAT/);
  await expect(page.getByRole('heading', { name: /পছন্দের সবকিছু/ })).toBeVisible();
  await expect(page.locator('#grid .card')).toHaveCount(8);
  await expect(page.locator('#resultCount')).toContainText('8');
  await expect(page.getByRole('button', { name: /কার্ট/ })).toBeVisible();
});

test('catalog search filters English and Bangla product names', async ({ page }) => {
  const search = page.getByPlaceholder('আপনার পছন্দের পণ্য খুঁজুন...');
  await search.fill('Wireless');
  await expect(page.locator('#grid .card')).toHaveCount(1);
  await expect(page.locator('#grid')).toContainText('ওয়্যারলেস ইয়ারবাড');

  await search.fill('কফি');
  await expect(page.locator('#grid .card')).toHaveCount(1);
  await expect(page.locator('#grid')).toContainText('কফি মগ সেট');

  await search.fill('no-such-product');
  await expect(page.locator('#grid .card')).toHaveCount(0);
  await expect(page.locator('#grid')).toContainText('কোনো পণ্য পাওয়া যায়নি');
});

test('category filters compose with search without changing the canonical catalog', async ({ page }) => {
  await page.locator('#cats [data-cat="fashion"]').click();
  await expect(page.locator('#grid .card')).toHaveCount(3);
  await page.getByPlaceholder('আপনার পছন্দের পণ্য খুঁজুন...').fill('Wallet');
  await expect(page.locator('#grid .card')).toHaveCount(1);
  await expect(page.locator('#grid')).toContainText('লেদার ওয়ালেট');

  await page.locator('#cats [data-cat="all"]').click();
  await expect(page.locator('#grid .card')).toHaveCount(1);
});

test('cart supports add, quantity increase/decrease, totals and empty state', async ({ page }) => {
  await page.locator('#grid [data-add="p1"]').click();
  await page.locator('#openCart').click();
  await expect(page.locator('#cartCount')).toHaveText('1');
  await expect(page.locator('#cartLines')).toContainText('ওয়্যারলেস ইয়ারবাড');
  await expect(page.locator('#cartTotal')).toHaveText('৳1,890');

  await page.locator('#cartLines [data-inc="p1"]').click();
  await expect(page.locator('#cartCount')).toHaveText('2');
  await expect(page.locator('#cartTotal')).toHaveText('৳3,780');

  await page.locator('#cartLines [data-dec="p1"]').click();
  await expect(page.locator('#cartCount')).toHaveText('1');
  await page.locator('#cartLines [data-dec="p1"]').click();
  await expect(page.locator('#cartCount')).toHaveText('0');
  await expect(page.locator('#cartLines')).toContainText('আপনার কার্ট এখনো খালি');
});

test('cart persists after reload and remains isolated between browser contexts', async ({ page, browser }) => {
  await page.locator('#grid [data-add="p2"]').click();
  await page.locator('#grid [data-add="p6"]').click();
  await expect(page.locator('#cartCount')).toHaveText('2');
  await page.reload();
  await expect(page.locator('#cartCount')).toHaveText('2');
  await page.locator('#openCart').click();
  await expect(page.locator('#cartLines')).toContainText('কটন পাঞ্জাবি');
  await expect(page.locator('#cartLines')).toContainText('কফি মগ সেট');

  const isolated = await browser.newContext();
  const otherPage = await isolated.newPage();
  await otherPage.goto('/');
  await expect(otherPage.locator('#cartCount')).toHaveText('0');
  await isolated.close();
});

test('checkout gives an explicit demo-only message and never submits a live order', async ({ page }) => {
  const apiRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });

  await page.locator('#openCart').click();
  await page.locator('#checkout').click();
  await expect(page.locator('#toast')).toContainText('কার্ট খালি আছে');

  await page.locator('#closeCart').click();
  await page.locator('#grid [data-add="p3"]').click();
  await page.locator('#openCart').click();
  await page.locator('#checkout').click();
  await expect(page.locator('#toast')).toContainText('শুধু ডেমো');
  await expect(page.locator('#cartCount')).toHaveText('1');
  expect(apiRequests).toEqual([]);
});

test('responsive layout keeps the canonical product grid usable on mobile and desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileColumns = await page.locator('#grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  expect(mobileColumns).toBe(2);
  await expect(page.locator('#openCart')).toBeVisible();
  await expect(page.locator('#grid .card').first()).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopColumns = await page.locator('#grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  expect(desktopColumns).toBe(4);
});
