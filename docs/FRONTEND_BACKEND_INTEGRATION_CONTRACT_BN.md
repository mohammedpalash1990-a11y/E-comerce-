# Frontend ↔ Backend Integration Contract (Bangla-first Marketplace)

> **Audit snapshot:** `main` at commit `8ea9522617af3606647f3502a36d3780883c443a` (2026-11-02).
>
> This document records the route surface found in the current `main` source. It is an integration inventory, **not** a claim that every route is already backed by PostgreSQL or production-ready. Re-check the implementation branch and tests before wiring a screen to an endpoint.

## 1. Source-of-truth and runtime boundary

- Preserve the existing root `index.html` storefront as the canonical standalone HTML demo. Do not replace it with a new template or remove existing interactions.
- The current `main` runtime is still SQLite-oriented: `server.modular.mjs` imports `core.mjs`, the SQLite route modules and `seed.mjs`; its default app is created without a PostgreSQL database.
- PostgreSQL pool, migration, catalog and auth modules exist, but their presence alone does not prove a PostgreSQL-only production runtime. README explicitly keeps production startup blocked.
- Current frontend pages are under `apps/web/public/` (`index.html`, `seller.html`, `admin.html`, `api-config.js`). The root storefront demo remains the visual baseline unless the project owner explicitly changes that decision.

## 2. Transport and response conventions observed in source

- API origin is configured as `window.HAAT_API_BASE`; configure the **origin only**, without appending `/api/v1` or a route.
- Health check: `GET /health`.
- API routes are under `/api/v1`.
- Authenticated requests send `Authorization: Bearer <token>`.
- Most successful route handlers use `{ "data": ... }`; register/login return `{ "token": "...", "data": ... }`.
- Errors use `{ "error": "..." }`; common HTTP meanings include 400 validation, 401 unauthenticated, 403 forbidden, 404 missing route/resource, 405 wrong method, 409 business conflict, 413 oversized body and 429 rate limit.
- Persisted monetary values use integer paisa. UI may display BDT fields returned by the API. Never trust a client-calculated total, discount, commission, shipping fee or stock value.

## 3. Endpoint inventory from current `main`

Legend: **Public** = no session required; **Customer**, **Seller**, **Admin** = role-protected; **Authenticated** = any valid signed-in role where the route is marked `AUTH`.

### Public catalogue and auth

| Method | Endpoint | Access | Source |
|---|---|---|---|
| GET | `/health` | Public | `routes_public.mjs` |
| GET | `/api/v1/categories` | Public | `routes_public.mjs` |
| GET | `/api/v1/brands` | Public | `routes_public.mjs` |
| GET | `/api/v1/products` | Public | `routes_public.mjs` |
| GET | `/api/v1/products/suggest` | Public | `routes_public.mjs` |
| GET | `/api/v1/products/:id` | Public | `routes_public.mjs` |
| GET | `/api/v1/products/:id/reviews` | Public | `routes_public.mjs` |
| GET | `/api/v1/shipping/quote` | Public | `routes_public.mjs` |
| POST | `/api/v1/auth/register` | Public | `routes_public.mjs` |
| POST | `/api/v1/auth/register-seller` | Public | `routes_public.mjs` |
| POST | `/api/v1/auth/login` | Public | `routes_public.mjs` |
| POST | `/api/v1/auth/logout` | Authenticated | `routes_public.mjs` |
| GET | `/api/v1/auth/me` | Authenticated | `routes_public.mjs` |
| PATCH | `/api/v1/me` | Authenticated | `routes_public.mjs` |
| POST | `/api/v1/auth/change-password` | Authenticated | `routes_public.mjs` |
| POST | `/api/v1/auth/forgot-password` | Public | `routes_public.mjs` |
| POST | `/api/v1/auth/reset-password` | Public | `routes_public.mjs` |
| POST | `/api/v1/auth/send-verification` | Authenticated | `routes_public.mjs` |
| POST | `/api/v1/auth/verify` | Authenticated | `routes_public.mjs` |
| GET | `/api/v1/notifications` | Authenticated | `routes_public.mjs` |
| POST | `/api/v1/notifications/read` | Authenticated | `routes_public.mjs` |

### Customer

| Method | Endpoint | Access |
|---|---|---|
| GET / POST | `/api/v1/customer/addresses` | Customer |
| PUT / DELETE | `/api/v1/customer/addresses/:id` | Customer |
| GET / POST | `/api/v1/customer/wishlist` | Customer |
| DELETE | `/api/v1/customer/wishlist/:pid` | Customer |
| GET / PUT / DELETE | `/api/v1/customer/cart` | Customer |
| DELETE | `/api/v1/customer/cart/:pid` | Customer |
| POST | `/api/v1/coupons/validate` | Customer |
| POST | `/api/v1/checkout` | Customer |
| GET | `/api/v1/customer/orders` | Customer |
| GET | `/api/v1/customer/orders/:id` | Customer |
| GET | `/api/v1/customer/orders/:id/tracking` | Customer |
| POST | `/api/v1/customer/orders/:id/cancel` | Customer |
| POST | `/api/v1/customer/orders/:id/pay` | Customer |
| POST | `/api/v1/customer/products/:id/reviews` | Customer |

### Seller

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/v1/seller/profile` | Seller |
| GET | `/api/v1/seller/dashboard` | Seller |
| GET / POST | `/api/v1/seller/products` | Seller |
| GET / PUT / DELETE | `/api/v1/seller/products/:id` | Seller |
| PATCH | `/api/v1/seller/products/:id/stock` | Seller |
| GET | `/api/v1/seller/orders` | Seller |
| GET | `/api/v1/seller/orders/:id` | Seller |
| POST | `/api/v1/seller/orders/:id/status` | Seller |
| GET | `/api/v1/seller/courier/quote` | Seller |
| POST | `/api/v1/seller/orders/:id/courier` | Seller |
| POST | `/api/v1/seller/shipments/:id/status` | Seller |
| GET | `/api/v1/seller/finance` | Seller |
| POST | `/api/v1/seller/payouts` | Seller |

### Admin

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/v1/admin/dashboard` | Admin |
| GET / PUT | `/api/v1/admin/customers` and `/api/v1/admin/customers/:id` | Admin |
| GET | `/api/v1/admin/customers/:id/orders` | Admin |
| POST | `/api/v1/admin/customers/:id/suspend` or `/activate` | Admin |
| GET | `/api/v1/admin/sellers` and `/api/v1/admin/sellers/:id` | Admin |
| GET | `/api/v1/admin/sellers/:id/products`, `/orders`, `/finance` | Admin |
| POST | `/api/v1/admin/sellers/:id/approve` or `/suspend` (action paths are generated in source) | Admin |
| PATCH | `/api/v1/admin/sellers/:id/commission` | Admin |
| GET / PUT / PATCH / DELETE | `/api/v1/admin/products` and product detail/action paths | Admin |
| GET / POST / PUT / DELETE | `/api/v1/admin/categories` and `/api/v1/admin/categories/:slug` | Admin |
| GET / POST / DELETE | `/api/v1/admin/brands` and `/api/v1/admin/brands/:slug` | Admin |
| GET | `/api/v1/admin/orders`, `/api/v1/admin/orders/:id` | Admin |
| POST | `/api/v1/admin/orders/:id/status`, `/note`, `/shipping` | Admin |
| POST | `/api/v1/admin/seller-orders/:id/courier` | Admin |
| POST | `/api/v1/admin/shipments/:id/status` | Admin |
| GET / POST | `/api/v1/admin/refunds`, `/api/v1/admin/orders/:id/refund` | Admin |
| POST | `/api/v1/admin/refunds/:id/approve` or `/reject` | Admin |
| GET | `/api/v1/admin/payouts` | Admin |
| POST | `/api/v1/admin/payouts/:id/approve` or `/reject` | Admin |
| GET | `/api/v1/admin/finance/summary`, `/transactions`, `/report` | Admin |
| GET | `/api/v1/admin/audit-logs` | Admin |
| GET / POST / PATCH | `/api/v1/admin/coupons` and `/api/v1/admin/coupons/:code` | Admin |

### Payments

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/v1/payments/callback/:gateway` | Public callback; signature verification is mandatory |
| GET | `/api/v1/payments/:id/status` | Customer, own payment only |
| POST | `/api/v1/payments/sandbox/:id/simulate` | Customer, own payment only; sandbox only |

## 4. Frontend integration rules

1. Keep the customer, seller and admin screens separate; never expose admin or seller-only controls in the public storefront.
2. Use the current API contract as a baseline, but verify the same endpoint and payload in the PostgreSQL implementation branch before integration.
3. Use the server-returned product price, stock, shipping, coupon discount and order total. Treat cart totals as display hints only.
4. Send the Bearer token only to the configured trusted API origin over HTTPS. Do not log tokens or include them in URLs.
5. Handle 401 by clearing the local session and asking the user to sign in again; handle 403 as an authorization failure, not as a reason to retry with another role.
6. Handle 409 as a business-state conflict (e.g. stock, duplicate or invalid transition) and refresh the relevant server state.
7. Show explicit loading, empty, success, offline and retry states. Do not silently substitute hard-coded sample products when the API fails.
8. Preserve Bengali-first copy and the existing canonical storefront visual language.

## 5. Required integration acceptance tests

- Public: health, categories, brands, product list/search/detail and reviews.
- Customer: registration/login/logout/session restore, address CRUD, cart CRUD, coupon validation, checkout, order history/detail/tracking/cancel and payment status.
- Seller: role isolation, own-product CRUD, stock update, own-order list/detail/status, shipment and finance/payout screens.
- Admin: protected dashboard, customer/seller moderation, product moderation, category/brand/coupon management, orders, refunds, payouts, finance and audit logs.
- Security: unauthenticated requests return 401; wrong-role requests return 403; customer A cannot read customer B's address/cart/order/payment; seller A cannot read or mutate seller B's product/order/shipment; admin-only actions remain inaccessible to customer/seller.
- Regression: root `index.html` and its existing demo interactions remain intact.

## 6. Ownership and coordination

- **Queen3coder:** frontend screens, responsive behavior, accessibility, API client wiring and Playwright browser/E2E suite.
- **Jules:** backend route/repository behavior, PostgreSQL runtime, authorization, database transactions and API contract parity.
- **Project owner/reviewer:** approves API contract changes and all merges/deployments.
- Any endpoint or response-shape change must be documented and coordinated before the frontend relies on it.

## 7. Known blockers — do not conceal these

- Current `main` API route modules are coupled to SQLite `core.mjs`; current modular server imports SQLite-backed modules and seed code.
- PostgreSQL-only production route composition and real PostgreSQL end-to-end verification remain separate release blockers.
- Payment and courier routes currently use adapters; do not label them as live Bangladesh provider integrations without provider sandbox/production evidence.
- The documented development demo accounts are not production credentials and must never be deployed as live accounts.
- This document does not certify production readiness and must be updated when route implementations change.
