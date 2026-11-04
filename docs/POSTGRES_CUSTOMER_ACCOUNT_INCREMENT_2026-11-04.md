# PostgreSQL customer account increment — 2026-11-04

Continuation of [PR #92](https://github.com/mohammedpalash1990-a11y/E-comerce-/pull/92) on `arena/0ce94763-e-comerce`, after admin coupon commit `c7c3cd0`. This slice exposes the already-implemented customer repository over HTTP: **saved delivery addresses, wishlist and verified-purchase reviews**.

## What was wrong before this change

`createPostgresApiServer` already constructed `createPostgresCustomerRepository(database)`, and that repository already had tests for address locking, the ten-address cap, wishlist visibility and delivered-purchase review eligibility. But **no route consumer existed**: the customer repository was passed into the server and never used, so every legacy customer-account endpoint returned 404 through the PostgreSQL API. The legacy SQLite app (`routes_customer.mjs`) already served these paths, so the PostgreSQL runtime was missing parity on a shipped customer feature, not adding a new one.

## Implemented endpoints

All eight routes are `CUSTOMER`-only. The owner is always the authenticated session user; a `userId` in the body is ignored, and another customer's resource id resolves to 404 (or a no-op delete) rather than leaking data.

### Saved addresses

- `GET /api/v1/customer/addresses` — default address first (`ORDER BY is_default DESC, id`).
- `POST /api/v1/customer/addresses` — 201 `{ data: { id } }`.
- `PUT /api/v1/customer/addresses/:id` — 200 `{ data: { id } }`.
- `DELETE /api/v1/customer/addresses/:id` — `{ data: { deleted: true } }`.

Behavior preserved from the legacy contract: `phone` is normalized and validated as a Bangladeshi mobile number; `name` defaults to the account name; `label` ≤40, `name` ≤100, `address` ≤500, `area` ≤100; `is_default` must be a real JSON boolean. The **first** saved address becomes the default automatically, at most **ten** addresses may be stored, and exactly one default is maintained: setting another address as default clears the previous one, clearing the flag or deleting the default promotes a remaining address.

The repository locks the owning customer row before reading the count and locks the address row for updates, so concurrent creation cannot exceed ten or leave two defaults. This is verified against real PostgreSQL with twelve simultaneous requests.

### Wishlist

- `GET /api/v1/customer/wishlist`
- `POST /api/v1/customer/wishlist` with `{ productId }` — 201 `{ data: { added: true } }`.
- `DELETE /api/v1/customer/wishlist/:pid` — `{ data: { removed: true } }`.

Only products that are `active=1`, `status='ACTIVE'` and owned by an `APPROVED` seller can be added; anything else is 404, matching product visibility everywhere else. Adding twice is idempotent (`ON CONFLICT DO NOTHING`) and does not reorder the list. Removal is scoped to the calling customer.

### Verified-purchase reviews

- `POST /api/v1/customer/products/:id/reviews` with `{ rating, comment? }` — 201 `{ data: { saved: true } }`.

A review requires a **DELIVERED** seller order containing that product for the calling customer; a merely `CONFIRMED` order is rejected with 403, and a product the customer never bought is 403. Rating must be an integer 1–5 (numeric strings are accepted after trimming); booleans, arrays, objects, `4.5`, `0`, `6` and free text are rejected with 400. Comment is optional, trimmed and limited to 1000 characters, and is validated **before** the eligibility query so malformed input never costs a database round trip. Each customer has one review per product: repeat submissions update rating/comment in place and keep the original creation timestamp.

## Correctness fixes found while exposing the routes

Three real defects surfaced only when these code paths were driven over HTTP against PostgreSQL. Each was fixed rather than papered over in the tests:

1. **`is_default` leaked the driver type.** PostgreSQL returns `BIGINT` as a string, so address responses contained `"is_default": "1"`. The list projection now returns the documented integer flag (`1`/`0`); existing clients comparing to `1` keep working.
2. **Review `rating` leaked the driver type.** `listReviews` returned `"5"` while the product aggregate returned `5`. The public review list now exposes a numeric rating, consistent with `/products/:id`.
3. **Boolean/array ratings were silently coerced.** `Number(true)` is `1` and `Number([])` is `0`, so a truthy flag could have become a one-star review. Rating input is now type-checked before numeric conversion, and the same strict identifier rule rejects non-string, empty and over-long product ids instead of letting array coercion reach SQL.

## Verification actually run

Node 22.22.3; disposable PostgreSQL 18.6 (UTF-8) on a local-only socket. No production database, customer data or live gateway was used.

| Check | Result |
| --- | --- |
| New customer account route unit tests + existing customer repository tests | 20 pass, 0 fail |
| New real PostgreSQL HTTP integration file | 9 pass (parent + 8 subtests), 0 fail |
| Final full `npm run check` with PostgreSQL configured (clean `npm ci`) | **354 pass, 0 fail, 0 skip** |
| OpenAPI validation | Pass, **17** documented paths |
| Migration CLI against the disposable database | Pass — 6 recorded, 0 applied |
| Syntax checks and `git diff --check` | Pass |
| Canonical Playwright storefront suite | **Not run this session** — see limitation below |

This adds 19 passing results over the previous 354-relation baseline (335 → 354): 6 route unit tests, 3 tightened repository tests, 1 HTTP boundary test in the server suite, 8 live subtests and the parent integration result.

The live suite drives the real HTTP server with real sessions and asserts: 401 for anonymous/suspended sessions and 403 for seller/admin; default-address promotion and single-default invariant; ten-address cap including two rejected requests among twelve concurrent ones; cross-customer isolation for update/delete/wishlist/review; hidden-product and unapproved-seller rejection; wishlist idempotency at the row level; review rejection before and after delivery; one-row upsert on repeat review; and public visibility through both `/products/:id/reviews` and the product rating aggregate.

Both expected-fault cases (403 before delivery, 400 for invalid input) are assertions on deliberate rejections, not skipped or tolerated failures.

**Environment limitation, stated plainly:** the sandbox was reset before this increment, which removed the external Playwright/Chromium tooling used in earlier reports. Re-installing the browser was attempted and **failed** because the Playwright browser CDN is not reachable from this environment's network policy (`Failed to download Chrome for Testing`). The storefront browser suite therefore **did not run for this increment** and no browser pass is claimed. Frontend files were not modified in this slice; the last verified browser result remains the 7/7 pass at `c7c3cd0`.

## Files changed

- `apps/api/src/postgres-customer-account-routes.mjs` (new): the eight CUSTOMER routes and their repository wiring.
- `apps/api/src/postgres-customer.mjs`: strict product/rating input handling, comment validation ordering, numeric `is_default`.
- `apps/api/src/postgres-catalog.mjs`: numeric review rating in the public review list.
- `apps/api/src/postgres-server.mjs`: mount the customer account routes with the existing repository instance.
- `tests/postgres-customer-account-routes.test.mjs` (new): route table, role scoping, session-owner wiring, error propagation.
- `tests/postgres-customer-account.integration.test.mjs` (new): real HTTP + PostgreSQL lifecycle and concurrency tests.
- `tests/postgres-customer.test.mjs`: identifier, rating-coercion and missing-body regressions.
- `tests/postgres-server.test.mjs`: HTTP role/method boundary for the eight paths.
- `openapi.yaml`: five new paths and address/wishlist schemas.
- `README.md`, `docs/DEPLOYMENT.md`, `docs/POSTGRES_ADMIN_COUPON_INCREMENT_2026-11-04.md`: links and the account-contract/historical-snapshot notes.
- `docs/POSTGRES_CUSTOMER_ACCOUNT_INCREMENT_2026-11-04.md`: this report.

## Deployment, remaining work and completion

No migration, backfill or seed data. The tables (`addresses`, `wishlists`, `reviews`) already exist in `001_init.sql`; this increment only exposes them. Rollback is a redeploy of the prior approved API — address, wishlist and review rows remain valid and readable by the legacy SQLite-era schema shape, so no data cleanup is required.

Not included, deliberately: review moderation/deletion or admin review listing, seller replies, wishlist sharing or price-drop notifications, Bangladesh district/upazila address taxonomy (current `area` remains free text), default-address enforcement at checkout, review eligibility after refunds/cancellations, and any frontend work for these screens.

Still open from earlier increments and unchanged: shipping policy injection (#91), coupon funding allocation across seller sub-orders, per-customer coupon limits, cancellation usage restoration, admin UI, and the canonical-vs-served storefront mismatch.

No frontend, seed, commission, courier, payment-gateway or production-gate change was made. Nothing was merged or deployed.

The coarse rubric stays **10/30 verified development checks (33.3%)**: this closes a real API parity gap, but browser acceptance for these customer screens, the complete checkout workflow and operational readiness are still missing, so the overall figure must not rise on backend slices alone.
