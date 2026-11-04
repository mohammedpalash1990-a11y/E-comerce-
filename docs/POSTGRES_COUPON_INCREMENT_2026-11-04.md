# PostgreSQL coupon increment — 2026-11-04

> Historical snapshot at `666da59`. The subsequent [admin coupon increment](POSTGRES_ADMIN_COUPON_INCREMENT_2026-11-04.md) implements admin list/create/activation APIs; its final full suite passes 335 tests. Missing-admin notes below describe this earlier snapshot.

Continuation of [PR #92](https://github.com/mohammedpalash1990-a11y/E-comerce-/pull/92) after cart commit `2cd4e36`, on the same `arena/0ce94763-e-comerce` branch. Coupon preview and checkout validation are implemented and tested. **This is not a complete storefront checkout or production release.**

## Existing work and coordination

Rechecked local changes, open PRs and team issue #86 before coding. Adapted the earlier PR #6 `validateCoupon` concept and preserved the existing FIXED/PERCENT schema and admin percentage bounds. Did not merge its older runtime stack or modify shipping PR #91.

[Scope handoff on Jules issue #86](https://github.com/mohammedpalash1990-a11y/E-comerce-/issues/86#issuecomment-6623297519) reserves customer coupon validation, preview and checkout wiring for Arena. Queen retains frontend integration; coupon-admin/settings UI and other backend/provider work remain separate. Comments record task separation, not external agent acceptance/execution.

## Implemented

- SQLite-independent PostgreSQL coupon repository with trimmed uppercase ASCII codes (letters/digits/underscore/hyphen, 1–30 characters).
- Validate existence, active status, expiry, minimum item subtotal, global use limit, counters, discount type and safe-integer monetary configuration.
- FIXED values remain integer paisa and are capped at item subtotal. PERCENT values preserve the existing 1–90 integer-percent contract. BigInt intermediate arithmetic floors to paisa without unsafe floating-point multiplication.
- Disabled, unknown, expired, exhausted and malformed stored coupons fail closed. A requested code is no longer silently ignored by the default checkout composition or by an invalid injected validator result.
- Customer-only `POST /api/v1/coupons/validate`, based on the authenticated customer's saved cart, not a client-provided subtotal or user ID.
- Read-only repeatable-read preview; no usage reservation, inventory reservation or cart mutation.
- Checkout uses the default coupon repository, locking the coupon row inside its existing customer/product/order transaction. The clock is read after the lock is acquired.
- Existing conditional usage increment remains inside the order transaction, together with stock reservation, parent/sub-orders, payment rows and cart cleanup. Failure rolls these changes back together.

No schema migration, coupon seed, new runtime dependency, frontend replacement, shipping/commission amount or production-gate change was made.

## HTTP and checkout contract

### Preview

`POST /api/v1/coupons/validate` requires an active CUSTOMER bearer session.

Request: `{ "code": "SAVE20" }`.

Response: `{ "data": { "code": "SAVE20", "discount_bdt": 5, "subtotal_bdt": 20 } }` (illustrative values only; no such coupon is created by this increment).

- Compatibility fields `code` and `discount_bdt` are retained; `subtotal_bdt` reports the server-derived amount.
- Client `subtotal_bdt`, `discount_bdt` and user-ID fields are ignored. The prior SQLite endpoint trusted the submitted subtotal; this new PostgreSQL endpoint intentionally does not. Synchronize the saved cart before requesting a preview.
- Empty cart: 400. Unavailable lines, excess quantity or excess distinct-product count: 409. Invalid/ineligible coupon or unmet minimum: 400. Missing/inactive session: 401. Wrong role: 403. Unsupported method: 405 with `Allow: POST`.
- Preview does not support a separate request-items basket. It does not reserve coupon availability or represent a final total/shipping quote.

### Checkout

Existing `coupon_code` input is normalized and revalidated using the server-priced order subtotal. Omitting/null/blank code means no coupon. Invalid types/codes are rejected. If a custom validator returns no matching code or no valid nonnegative integer discount, checkout fails closed with 503 instead of silently charging an undiscounted order.

A coupon's eligibility is evaluated at lock acquisition/validation time, not guaranteed by an earlier preview. Expiry is exclusive: a coupon expiring exactly at the validation instant is unavailable. Explicit timezone ISO timestamps are supported; legacy `YYYY-MM-DD` values mean **the start of that date at midnight UTC**. Invalid dates, empty expiry strings and timezone-less timestamps are rejected. Use an explicit `+06:00` timestamp when expressing Bangladesh wall time; no implicit local-time assumption is made.

Discount applies only to item subtotal, never shipping. The order stores its coupon code and integer-paisa discount; the payment amount follows the discounted parent total.

## Financial and launch limitations — owner approval still required

- **Coupon funding/settlement is not newly designed here.** Existing behavior discounts the parent order while seller sub-order subtotals/commission/net calculations remain unchanged. It does not allocate discounts to sellers. Owner approval of funding responsibility and reconciliation is a production blocker; this code is not proof of a complete settlement ledger.
- Global `max_uses` counts accepted order redemptions, not per-customer usage. Existing cancellation/payment-failure rules do not automatically restore coupon uses. Those business rules remain an explicit follow-up decision.
- Coupon administration endpoints/UI for PostgreSQL are still missing. This increment reads configured table records; tests create disposable fixture coupons only.
- Shipping policy #91 remains unmerged by this session. Successful repository tests inject a fixture-only shipping callback. No public HTTP checkout, live payment or full browser checkout completion is claimed.

## Verification actually run

Environment: Node 22.22.3; disposable local PostgreSQL 18.6 / UTF-8, not a production database.

| Check | Result |
| --- | --- |
| Initial coupon unit + checkout + server test files | 44 pass, 0 fail |
| New real PostgreSQL coupon integration file | 9 pass (parent plus 8 subtests), 0 fail |
| Clean `npm ci --no-audit --no-fund` | Pass |
| Final full `npm run check`, including malformed-validator regression | **310 pass, 0 fail, 0 skip** |
| Existing canonical Playwright browser suite | **7 pass**, includes 390px/1440px layouts |
| OpenAPI validation using `@apidevtools/swagger-parser` | Pass, 10 documented paths |
| Migration CLI against the disposable database | Pass — 6 recorded, 0 reapplied |
| New-module syntax checks and `git diff --check` | Pass |

The final suite adds 25 passing results over the previous cart increment (285): 11 coupon unit/route tests, 4 checkout tests, 1 HTTP boundary test, and 9 real-database integration results. No test failures occurred in these increment runs. Browser tests still cover the canonical static demo, not a live coupon UI. The local browser uses test-only Chromium/libraries outside Git and video disabled; assertions are unchanged.

Live integration verifies forged subtotal/ownership rejection, read-only previews, actual fixed/percentage payment totals, subtotal-capped discounts, revalidation after exhausted usage or changed catalog price, late-error rollback, and a real coupon lock wait between different buyers with different products competing for the final use. Another test holds the coupon row lock while an injected validation clock crosses expiry, then verifies rejection after the wait. Neither test relies only on a fake database or a timing-only success assertion.

## Changed files

- `apps/api/src/postgres-coupons.mjs`: shared normalization, eligibility, locking and exact discount arithmetic.
- `apps/api/src/postgres-coupon-routes.mjs`: customer preview over a server-cart snapshot.
- `apps/api/src/postgres-checkout.mjs`: default validator wiring and fail-closed result checks.
- `apps/api/src/postgres-server.mjs`: mount preview route; no shipping/production changes.
- `tests/postgres-coupons.test.mjs`: unit/preview contract, boundary, corruption, expiry and arithmetic tests.
- `tests/postgres-coupons.integration.test.mjs`: real HTTP/database redemption, contention and rollback tests.
- `tests/postgres-checkout.test.mjs`, `tests/postgres-server.test.mjs`: integration boundary regressions.
- `openapi.yaml`: preview contract and response schemas.
- `README.md`, `docs/DEPLOYMENT.md`, `docs/POSTGRES_CART_INCREMENT_2026-11-04.md`: updated links and rollout guidance.
- `docs/POSTGRES_COUPON_INCREMENT_2026-11-04.md`: this report.

## Deployment and next work

No migration/backfill is needed. In private staging, deploy coupon validation and checkout wiring together after draining old instances. Do not mix writers that ignore coupon codes with writers that redeem them. Rollback retains recorded orders/discounts/usage counters; never reset counters or delete orders to undo a code release. A rollback to older code loses safe coupon handling, so disable coupon test traffic before rollback.

Next: owner-reviewed coupon administration and funding rules; separate shipping-policy review; integrated customer frontend/cart/coupon/checkout browser acceptance. Native mobile, live providers, backup/restore, monitoring and independent security/financial acceptance remain open. Production startup stays blocked.

The earlier coarse 30-check development rubric remains **10/30 (33.3%)**: its combined end-to-end cart/coupon/shipping/browser criterion is still incomplete. Completing this backend increment alone does not justify raising the whole-workflow score or claiming launch readiness.
