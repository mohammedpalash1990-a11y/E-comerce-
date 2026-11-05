import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const spec = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
const modules = [
  '../apps/api/src/postgres-commerce-routes.mjs',
  '../apps/api/src/postgres-seller-workspace-routes.mjs',
  '../apps/api/src/postgres-seller-product-routes.mjs',
  '../apps/api/src/postgres-admin-seller-routes.mjs',
  '../apps/api/src/postgres-admin-product-routes.mjs',
  '../apps/api/src/postgres-admin-order-routes.mjs',
  '../apps/api/src/postgres-payout-routes.mjs',
  '../apps/api/src/postgres-admin-dashboard-routes.mjs'
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
const inventory = readFileSync(new URL('../apps/api/src/postgres-inventory-workspace.mjs', import.meta.url), 'utf8');

const operations = [
  ['GET','/api/v1/seller/profile'],['GET','/api/v1/seller/dashboard'],
  ['GET','/api/v1/seller/orders'],['GET','/api/v1/seller/orders/{id}'],
  ['POST','/api/v1/seller/orders/{id}/status'],['GET','/api/v1/seller/products'],
  ['GET','/api/v1/seller/products/{id}'],['POST','/api/v1/seller/products'],
  ['PUT','/api/v1/seller/products/{id}'],['DELETE','/api/v1/seller/products/{id}'],
  ['GET','/api/v1/seller/finance'],['POST','/api/v1/seller/payouts'],
  ['GET','/api/v1/seller/inventory'],['GET','/api/v1/seller/inventory/{id}/movements'],
  ['POST','/api/v1/seller/inventory/{id}/adjust-requests'],['GET','/api/v1/seller/inventory/alerts'],
  ['GET','/api/v1/seller/inventory/report'],['GET','/api/v1/admin/sellers'],
  ['PATCH','/api/v1/admin/sellers/{id}/status'],['GET','/api/v1/admin/products'],
  ['GET','/api/v1/admin/products/pending'],['POST','/api/v1/admin/products/{id}/approve'],
  ['POST','/api/v1/admin/products/{id}/reject'],['POST','/api/v1/admin/products/{id}/suspend'],
  ['POST','/api/v1/admin/products/{id}/unsuspend'],['GET','/api/v1/admin/orders'],
  ['POST','/api/v1/admin/orders/{id}/status'],['GET','/api/v1/admin/orders/{id}'],
  ['POST','/api/v1/admin/orders/{id}/note'],['POST','/api/v1/admin/orders/{id}/shipping'],
  ['GET','/api/v1/admin/dashboard'],['GET','/api/v1/admin/inventory/adjustments'],
  ['POST','/api/v1/admin/inventory/adjustments/{id}/decision'],
  ['GET','/api/v1/admin/inventory/alerts'],['GET','/api/v1/admin/inventory/report'],
  ['GET','/api/v1/admin/payouts'],['POST','/api/v1/admin/payouts/{id}/decision']
];

function operation(path, method) {
  const start = spec.indexOf('  ' + path + ':');
  assert.notEqual(start, -1, 'Missing path: ' + path);
  const next = spec.indexOf('\n  /', start + 1);
  const block = spec.slice(start, next < 0 ? spec.indexOf('\ncomponents:', start) : next);
  const methodStart = block.indexOf('\n    ' + method.toLowerCase() + ':');
  assert.notEqual(methodStart, -1, 'Missing operation: ' + method + ' ' + path);
  const after = block.slice(methodStart + method.length + 7);
  const nextMethod = after.search(/\n    (get|post|put|patch|delete|options|head):/);
  return nextMethod < 0 ? after : after.slice(0, nextMethod);
}

test('seller/admin domain operations have authenticated OpenAPI contracts and matching handlers', () => {
  for (const [method,path] of operations) {
    const op = operation(path, method);
    assert.match(op, /summary:/);
    assert.match(op, /security: \[\{ bearerAuth: \[\] \}\]/);
    assert.match(op, /responses:/);
    if (['POST','PUT','PATCH'].includes(method)) assert.match(op, /requestBody:/);
    const source = path.includes('/inventory') ? inventory : modules;
    const normalized = path.replaceAll('{id}', ':id');
    const dynamicInventoryPatterns = {
      '/api/v1/seller/inventory/{id}/movements': 'const productMovement = path.match(/^\\/api\\/v1\\/seller\\/inventory\\/([^/]+)\\/movements$/);',
      '/api/v1/seller/inventory/{id}/adjust-requests': 'const adjustmentRequest = path.match(/^\\/api\\/v1\\/seller\\/inventory\\/([^/]+)\\/adjust-requests$/);',
      '/api/v1/admin/inventory/adjustments/{id}/decision': 'const requestDecision = path.match(/^\\/api\\/v1\\/admin\\/inventory\\/adjustments\\/([^/]+)\\/decision$/);'
    };
    const dynamicInventoryMatch = dynamicInventoryPatterns[path] && inventory.includes(dynamicInventoryPatterns[path]);
    assert.ok(source.includes(normalized) || source.includes(normalized.replace(':id','')) || dynamicInventoryMatch ||
      (path.includes('/admin/products/{id}/') && source.includes("'/api/v1/admin/products/:id/' + action")),
      'Missing handler path reference: ' + method + ' ' + path);
  }
});

test('admin payout query contract matches handler limits and status values', () => {
  const op = operation('/api/v1/admin/payouts','GET');
  assert.match(op, /name: status/);
  assert.match(op, /REQUESTED, APPROVED, REJECTED/);
  assert.match(op, /maximum: 300/);
});

test('seller product, payout and admin order write operations reference bounded request schemas', () => {
  assert.match(operation('/api/v1/seller/products','POST'), /SellerProductInput/);
  assert.match(operation('/api/v1/seller/products/{id}','PUT'), /SellerProductPatch/);
  assert.match(operation('/api/v1/seller/payouts','POST'), /SellerPayoutRequest/);
  assert.match(operation('/api/v1/admin/orders/{id}/note','POST'), /AdminOrderNoteInput/);
  assert.match(operation('/api/v1/admin/orders/{id}/shipping','POST'), /AdminShippingInput/);
  assert.match(spec, /maxItems: 6/);
  assert.match(spec, /maximum: 1000000/);
  assert.match(spec, /enum: \[BKASH, NAGAD, ROCKET, BANK\]/);
});


test('seller product operations expose precise response schemas and creation status', () => {
  const list = operation('/api/v1/seller/products', 'GET');
  const create = operation('/api/v1/seller/products', 'POST');
  const detail = operation('/api/v1/seller/products/{id}', 'GET');
  const update = operation('/api/v1/seller/products/{id}', 'PUT');
  const archive = operation('/api/v1/seller/products/{id}', 'DELETE');

  assert.ok(list.includes('SellerProductListItem'));
  assert.ok(create.includes("'201':"));
  assert.ok(create.includes('SellerProductMutationResult'));
  assert.ok(!create.includes("'200':"));
  assert.ok(detail.includes('SellerProductDetail'));
  assert.ok(update.includes('SellerProductMutationResult'));
  assert.ok(archive.includes('SellerProductArchiveResult'));

  const schemaStart = spec.indexOf('    SellerProductListItem:');
  const schemaEnd = spec.indexOf('    SellerProductInput:', schemaStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart, 'Seller product response schemas must be defined');
  const schemas = spec.slice(schemaStart, schemaEnd);
  for (const field of ['price_paisa', 'price_bdt', 'discount_paisa', 'discount_price_bdt', 'stock', 'status', 'sku', 'category_slug', 'description', 'active', 'image', 'updated_at']) {
    assert.ok(schemas.includes(field + ':'), 'Missing seller product response field ' + field);
  }
  assert.ok(schemas.includes('variants:'));
  assert.ok(schemas.includes('images:'));
  assert.ok(schemas.includes('enum: [PENDING_REVIEW, ACTIVE, REJECTED, SUSPENDED, ARCHIVED]'));
  assert.ok(schemas.includes('SellerProductMutationResult:'));
  assert.ok(schemas.includes('required: [id, status, message]'));
  assert.ok(schemas.includes('SellerProductArchiveResult:'));
  assert.ok(schemas.includes('required: [id, archived]'));
});

test('seller finance and payout routes use role-scoped typed contracts', () => {
  const finance = operation('/api/v1/seller/finance', 'GET');
  const request = operation('/api/v1/seller/payouts', 'POST');
  const adminList = operation('/api/v1/admin/payouts', 'GET');
  const decision = operation('/api/v1/admin/payouts/{id}/decision', 'POST');

  assert.ok(finance.includes('SellerFinanceSummary'));
  assert.ok(request.includes("'201':"));
  assert.ok(request.includes('SellerPayoutCreated'));
  assert.ok(adminList.includes('AdminPayoutListItem'));
  assert.ok(decision.includes('PayoutDecisionInput'));
  assert.ok(decision.includes('AdminPayoutDecisionResult'));

  for (const name of ['SellerSettlement', 'SellerPayoutHistoryItem', 'SellerFinanceSummary', 'SellerPayoutCreated', 'AdminPayoutListItem', 'PayoutDecisionInput', 'AdminPayoutDecisionResult']) {
    assert.ok(spec.includes('    ' + name + ':'), 'Missing payout schema ' + name);
  }
  assert.ok(spec.includes('enum: [BKASH, NAGAD, ROCKET, BANK]'));
  assert.ok(spec.includes('enum: [APPROVE, REJECT]'));
  assert.ok(spec.includes('maxLength: 300'));
});


test('admin order detail, dashboard and seller/admin inventory use typed response contracts', () => {
  const detail = operation('/api/v1/admin/orders/{id}', 'GET');
  const dashboard = operation('/api/v1/admin/dashboard', 'GET');
  const sellerInventory = operation('/api/v1/seller/inventory', 'GET');
  const movements = operation('/api/v1/seller/inventory/{id}/movements', 'GET');
  const sellerAdjust = operation('/api/v1/seller/inventory/{id}/adjust-requests', 'POST');
  const adminAdjustments = operation('/api/v1/admin/inventory/adjustments', 'GET');
  const adminDecision = operation('/api/v1/admin/inventory/adjustments/{id}/decision', 'POST');
  const sellerAlerts = operation('/api/v1/seller/inventory/alerts', 'GET');
  const adminAlerts = operation('/api/v1/admin/inventory/alerts', 'GET');
  const sellerReport = operation('/api/v1/seller/inventory/report', 'GET');
  const adminReport = operation('/api/v1/admin/inventory/report', 'GET');

  assert.ok(detail.includes('AdminOrderDetail'));
  assert.ok(dashboard.includes('AdminDashboardMetrics'));
  assert.ok(sellerInventory.includes('SellerInventoryList'));
  assert.ok(movements.includes('InventoryMovementList'));
  assert.ok(sellerAdjust.includes('InventoryAdjustmentRequest'));
  assert.ok(sellerAdjust.includes("'201':"));
  assert.ok(!sellerAdjust.includes("'200':"));
  assert.ok(adminAdjustments.includes('AdminInventoryAdjustmentList'));
  assert.ok(adminDecision.includes('InventoryAdjustmentDecisionInput'));
  assert.ok(adminDecision.includes('InventoryAdjustmentDecision'));
  assert.ok(sellerAlerts.includes('InventoryAlertList'));
  assert.ok(adminAlerts.includes('InventoryAlertList'));
  assert.ok(sellerReport.includes('InventoryReport'));
  assert.ok(adminReport.includes('InventoryReport'));

  for (const name of ['AdminOrderDetail','AdminOrderItem','AdminOrderSeller','AdminOrderEvent','AdminOrderPayment',
    'AdminDashboardMetrics','SellerInventoryItem','InventoryMovement','InventoryAdjustmentInput',
    'InventoryAdjustmentRequest','InventoryAdjustmentDecisionInput','InventoryAdjustmentDecision',
    'InventoryAlert','InventoryReport']) {
    assert.ok(spec.includes('    ' + name + ':'), 'Missing schema ' + name);
  }
  assert.match(spec, /idempotency_key: \{ type: string, pattern:/);
  assert.match(spec, /enum: \\[PENDING, APPROVED, REJECTED\\]/);
});
