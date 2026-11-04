# PostgreSQL seller/admin/inventory/payout OpenAPI coverage audit

Date: 2026-11-04
Base: `main` at the public catalog contract merge from PR #98.

## Scope and method

Compared the route registrations mounted by `postgres-server.mjs` against `openapi.yaml`. Sources inspected: seller workspace/product routes, admin seller/product/order/dashboard routes, commerce routes, inventory workspace dispatch, payout routes, and existing customer/cart/coupon/catalog routes.

The scan found 58 mounted PostgreSQL domain operations in the inspected modules. The OpenAPI file already describes the customer/cart/coupon/catalog/checkout subset, but it does not yet describe the seller/admin workspace surfaces listed below. The wishlist DELETE route is already covered by `/api/v1/customer/wishlist/{productId}`; the implementation calls the placeholder `:pid`, which is the same one-segment route shape and is not counted as a missing operation.

## Confirmed missing OpenAPI operations

### Seller workspace and product management
- GET `/api/v1/seller/profile`
- GET `/api/v1/seller/dashboard`
- GET `/api/v1/seller/orders`
- GET `/api/v1/seller/orders/{id}`
- POST `/api/v1/seller/orders/{id}/status`
- GET `/api/v1/seller/products`
- GET `/api/v1/seller/products/{id}`
- POST `/api/v1/seller/products`
- PUT `/api/v1/seller/products/{id}`
- DELETE `/api/v1/seller/products/{id}`
- GET `/api/v1/seller/finance`
- POST `/api/v1/seller/payouts`

### Seller inventory and stock adjustments
- GET `/api/v1/seller/inventory`
- GET `/api/v1/seller/inventory/{id}/movements`
- POST `/api/v1/seller/inventory/{id}/adjust-requests`
- GET `/api/v1/seller/inventory/alerts`
- GET `/api/v1/seller/inventory/report`

### Admin seller, product, order and dashboard
- GET `/api/v1/admin/sellers`
- PATCH `/api/v1/admin/sellers/{id}/status`
- GET `/api/v1/admin/products`
- GET `/api/v1/admin/products/pending`
- POST `/api/v1/admin/products/{id}/approve`
- POST `/api/v1/admin/products/{id}/reject`
- POST `/api/v1/admin/products/{id}/suspend`
- POST `/api/v1/admin/products/{id}/unsuspend`
- GET `/api/v1/admin/orders`
- POST `/api/v1/admin/orders/{id}/status`
- GET `/api/v1/admin/orders/{id}`
- POST `/api/v1/admin/orders/{id}/note`
- POST `/api/v1/admin/orders/{id}/shipping`
- GET `/api/v1/admin/dashboard`

### Admin inventory and payouts
- GET `/api/v1/admin/inventory/adjustments`
- POST `/api/v1/admin/inventory/adjustments/{id}/decision`
- GET `/api/v1/admin/inventory/alerts`
- GET `/api/v1/admin/inventory/report`
- GET `/api/v1/admin/payouts`
- POST `/api/v1/admin/payouts/{id}/decision`

## Contract risks to address while documenting

1. The payout admin list parses `limit` with `parseInt` and clamps it but does not reject malformed, duplicate, or negative offset-like inputs; document actual behavior rather than promising stricter validation.
2. Seller product list and admin product list use bounded/clamped pagination, but their accepted query parameters and response projections differ. They need separate schemas.
3. Seller inventory movement and report endpoints are role-scoped. The contract must not expose another seller's stock history or account identifiers.
4. Seller payout request and admin payout decision are financial mutations. Document the allowed payout methods, status transitions, and conflict/validation responses accurately.
5. Admin order detail includes customer contact and payment/order data. Mark it ADMIN-only and do not reuse the customer order schema.
6. Inventory adjustment requests have an approval workflow and must be described separately from direct stock updates.
7. The admin product action paths are generated from a fixed allowlist: approve, reject, suspend and unsuspend. No arbitrary action suffix is supported.

## Runtime status

This audit changes no runtime code and makes no production-readiness claim. The PostgreSQL API's production startup gate remains fail-closed. The next implementation step is to add the missing OpenAPI path/method contracts and focused route-to-contract regression tests, using the current route handlers as the source of truth.
