# PostgreSQL admin coupon increment — 2026-11-04

Continuation of [PR #92](https://github.com/mohammedpalash1990-a11y/E-comerce-/pull/92), after coupon-validation commit `666da59`, on the same `arena/0ce94763-e-comerce` branch. The **admin coupon API** is implemented and tested. The admin browser interface, complete checkout deployment and production launch are not complete.

## Existing work preserved / coordination

Rechecked the branch, open PRs and issue #86. Reviewed the existing SQLite coupon routes and the equivalent list/create/toggle logic in older PostgreSQL workspace PR #19. Preserved their endpoint paths, response envelopes, stored-unit list fields and `COUPON_CREATE` / `COUPON_TOGGLE` audit action names. Adapted the scope into an isolated PostgreSQL route module instead of merging the older workspace/runtime stack.

The [Jules scope handoff](https://github.com/mohammedpalash1990-a11y/E-comerce-/issues/86#issuecomment-6623473042) reserves this slice for Arena. Queen retains frontend integration; shipping PR #91, other platform settings and owner-approved coupon funding remain separate. No other branch was checked out or modified, and no external agent execution is claimed.

## Implemented contract

All three endpoints require an active ADMIN bearer session. Mutations also recheck/lock the active administrator row inside the transaction; audit actor IDs come from the session, never a submitted body field.

### `GET /api/v1/admin/coupons`

Returns `{ data: [ ...coupons ] }`, ordered by code.

- `limit`: default 100, allowed 1–300.
- `offset`: default 0, allowed 0–10000.
- Optional `active=0` or `active=1` filter. This is the stored switch, not a guarantee that an unexpired/use-eligible coupon exists.
- Malformed or repeated limit/offset/active parameters return 400; values are bound parameters, not interpolated SQL.
- Retains `code`, `type`, `value`, `min_order_paisa`, `max_uses`, `used_count`, `expires_at`, numeric `active`.
- Adds `value_bdt` for FIXED coupons (null for PERCENT) and `min_order_bdt` display helpers.

**Unit warning for frontend integration:** list `value` is stored **paisa** for FIXED, while create `value` is **BDT**. This retains the existing contract; use `value_bdt` to populate a fixed-discount form. PERCENT `value` is a whole percentage in both directions. Do not double-convert or treat a raw paisa value as BDT.

### `POST /api/v1/admin/coupons`

Required fields: `code`, `type`, `value`.

- Code is trimmed/uppercased and follows the existing 1–30-character letter/digit/underscore/hyphen rule.
- Type must explicitly be `FIXED` or `PERCENT`; unsupported/missing types are not silently interpreted as percentage discounts.
- FIXED `value` is positive BDT, as a number or plain decimal string with at most two decimals. Conversion uses integer arithmetic; extra decimal places are rejected, not rounded silently. Prefer strings for exact decimal input.
- PERCENT `value` is a whole number from 1 to 90, preserving the established coupon contract rather than choosing a discount rate for the owner.
- Optional `min_order_bdt` is nonnegative, at most two decimals; omitted/empty means zero.
- Optional `max_uses` is a positive safe integer; omitted/null/empty means unlimited global uses. Zero, negative, fractional, boolean or unsafe values are rejected.
- Optional `expires_at` accepts a future timezone-qualified ISO timestamp or legacy date (start of that date at midnight UTC), normalized to UTC ISO. Omitted/null/empty means no expiry. Invalid or past dates are rejected, even for initially inactive coupons. Future validation happens after the admin lock is acquired.
- Optional JSON boolean `active` defaults to true, preserving the old creation behavior; false supports staging a disabled coupon.
- Unknown fields—including `used_count`, actor IDs and alternate monetary fields—are rejected. Usage always starts at zero.

Returns 201 `{ data: { code } }`. A duplicate normalized code returns 409 without overwriting the existing coupon. Creation and its normalized-term audit record commit or roll back together. No actual coupon code or discount amount is seeded by this increment.

### `PATCH /api/v1/admin/coupons/:code`

Accepts **only** `{ "active": true }` or `{ "active": false }`. Strings such as `"false"`, numeric flags and missing booleans return 400 rather than accidentally enabling a coupon.

Returns `{ data: { code, active } }` with boolean `active`. Coupon terms and usage counts are immutable through this route. Unknown coupon: 404. Re-enabling an expired, exhausted or invalid coupon: 409. Same-state repeats produce no duplicate transition audit. There is no destructive delete or usage-reset endpoint.

The transaction locks the coupon using the same row lock as checkout. An already-locked checkout may commit first; deactivation then preserves its incremented usage count. If deactivation obtains the lock first, a waiting checkout sees the disabled coupon and fails. Deactivation never retroactively cancels an accepted order.

## Audits and integrity

- Create writes a normalized configuration snapshot under `COUPON_CREATE` / entity `coupon`.
- Real transitions write prior/new activation state and observed usage under `COUPON_TOGGLE`.
- The previous activation value is captured **before** the update, rather than read from a potentially mutable adapter row afterward.
- A failed audit insert rolls back the coupon insert/update. HTTP errors do not expose the injected internal failure text.
- Concurrent same-code creations produce one coupon and one creation audit; concurrent same-state toggles produce one transition audit.
- Audit records are persisted/tested directly; a full PostgreSQL audit-log viewer and admin UI remain separate work.

## Verification actually run

Local environment: Node 22.22.3; disposable PostgreSQL 18.6 / UTF-8. No production database or customer data was accessed.

| Check | Result |
| --- | --- |
| Admin coupon unit + existing coupon/server tests, corrected rerun | 47 pass, 0 fail |
| New real PostgreSQL HTTP integration file | 11 pass (parent plus 10 subtests), 0 fail |
| Clean `npm ci --no-audit --no-fund` | Pass |
| Final full `npm run check` with PostgreSQL configured | **335 pass, 0 fail, 0 skip** |
| Existing canonical Playwright browser suite | **7 pass**, including mobile/desktop layout checks |
| OpenAPI validation | Pass, 12 documented paths |
| Migration CLI against the disposable database | Pass — 6 recorded, 0 reapplied |
| New-module syntax and `git diff --check` | Pass |

This adds 25 passing results over the previous 310-test increment: 13 admin coupon unit tests, 1 HTTP role/method test and 11 real-database integration results. The live suite creates coupons through HTTP rather than directly seeding coupon rows, tests redemption through the existing checkout repository with a fixture-only shipping callback, and observes real PostgreSQL lock waits in **both** checkout/deactivation orderings.

**Failure found and fixed:** the first unit run had 46 passes and one failed audit-before-state assertion. The deterministic adapter returned a mutable row that changed during UPDATE. Capturing the prior state before the write fixed the invariant without weakening the test; corrected focused and full reruns passed. Live tests intentionally inject audit failures and assert HTTP 500 plus full rollback; those expected fault responses are not failed tests.

Browser tests still cover the canonical static storefront, not a new admin coupon UI or full live checkout. Local browser executable/libraries are test-only files outside Git, with video disabled and assertions unchanged. Existing production guards remain enabled.

## Files changed

- `apps/api/src/postgres-admin-coupon-routes.mjs`: three admin routes, strict validation, exact money, bounded list and atomic audits.
- `apps/api/src/postgres-coupons.mjs`: export the existing expiry parser for shared admin/redemption date semantics; no change to its parsing behavior.
- `apps/api/src/postgres-server.mjs`: mount admin coupon routes.
- `tests/postgres-admin-coupon-routes.test.mjs`: deterministic validation, transaction and audit tests.
- `tests/postgres-admin-coupons.integration.test.mjs`: real HTTP/DB lifecycle, audit failure, duplicate and redemption contention tests.
- `tests/postgres-server.test.mjs`: always-running ADMIN boundary and method tests.
- `openapi.yaml`: admin coupon endpoints and schemas.
- `README.md`, `docs/DEPLOYMENT.md`, `docs/POSTGRES_COUPON_INCREMENT_2026-11-04.md`: current contract/rollout links and historical-snapshot clarification.
- `docs/POSTGRES_ADMIN_COUPON_INCREMENT_2026-11-04.md`: this report and team handoff.

## Deployment, remaining work and completion

No migration/backfill is required. For private staging, deploy the admin module with the reviewed coupon-validation/checkout code, drain old writers and review the normalized expiry/amount contract. Rollback by redeploying the prior approved API without deleting coupons, audit records, orders or usage counts. Old admin writers may not provide these validation/audit guarantees, so disable admin coupon test traffic before rollback.

Shipping #91 remains separate and unmerged by this session. No frontend file, seed data, commission rate, courier/payment integration or production gate was changed. Admin browser integration, owner approval of coupon funding/cancellation rules, a complete settlement ledger, shipping integration and full browser checkout acceptance remain open. Parent-order discounting still does not allocate the discount to seller sub-orders; this financial policy must not be treated as resolved by coupon administration.

The earlier coarse rubric remains **10/30 verified development checks (33.3%)**, not production readiness: its broad admin/end-to-end checkout criteria still include missing UI, settings and operational acceptance. This backend increment is complete within its stated scope; the marketplace is not ready to launch.
