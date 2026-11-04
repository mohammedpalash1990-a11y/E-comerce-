# Marketplace development delivery — 2026-11-04

> Historical snapshot of the initial order-read/dispatch increment at `efb68fd`. The subsequent [cart increment](POSTGRES_CART_INCREMENT_2026-11-04.md) adds saved-cart routes and checkout concurrency fixes; its final full suite passes 285 tests. Counts and missing-cart notes below describe the initial increment, not the latest branch head.

## Scope and verdict

Branch: `arena/0ce94763-e-comerce`, based on `bda1453` (merged PR #90).
This is a tested incremental backend delivery, **not a production-launch completion**.
No production deployment, merge, live provider call, monetary-policy decision, or frontend replacement was performed.

## Repository and team audit

Inspected the tracked tree: active API/web code, tests, all migration directories, scripts, workflow/deployment configuration, Prisma target schema, documentation, root storefront, historical ZIP listing and `zip-import` conflict tree. The archive/conflict tree is preserved; it is not the active runtime.

- **Canonical design baseline:** root `index.html`, as identified by the existing search/accessibility documentation and `tests/serve-canonical-storefront.mjs`. It is a Bengali-first static demo with eight products, sorting, product details, cart and explicit demo checkout.
- **Different served storefront:** `apps/web/server.mjs` and the Pages workflow serve `apps/web/public/index.html`. That API-backed frontend is not identical to the root canonical demo. Neither file was overwritten.
- **Default API:** `server.mjs` imports the modular SQLite development API. `server.legacy.mjs` is retained history. The PostgreSQL API has its own explicit entrypoint, repositories, migrations and route composition; it is not a SQLite fallback.
- **PostgreSQL state:** catalog, authentication, addresses/wishlist/reviews, commerce, seller products/workspace, admin orders/moderation/approvals/dashboard, payouts and inventory modules already existed. Some corresponding routes/UI integrations remain absent. `prisma/schema.prisma` is not the migration source of truth for these repositories.
- **Production safety:** both runtime paths deliberately reject production startup. `DATABASE_URL` is consumed by the explicit PostgreSQL entrypoint, contrary to older historical status documentation.
- **Current-file gaps:** no `customer.html` exists in this checkout, despite earlier PR #9–#12 descriptions of an account portal. Do not infer current functionality from historical PR prose alone.
- **Shipping:** main fails closed without an injected shipping policy. Open PR #91 addresses composition. This delivery does not duplicate it or decide delivery prices.

Reviewed remote branch names, recent/all available PR metadata and relevant commit bodies, and open issue scopes. The checkout is shallow; GitHub PR metadata supplements its one-commit local history. Jules attribution is explicit in merged catalog PR #82, retained in #85. Earlier frontend PRs #9–#12 and later root storefront work #41/#44/#45 exist; their common GitHub author does not independently prove Queen authored every change.

Open PRs #6/#13/#19/#23/#27 are older overlapping stacks requiring comparison before integration. #65 appears superseded by #82/#85; do not merge it blindly. No PR was closed or merged.

### Team separation recorded on GitHub

- [Jules issue #86](https://github.com/mohammedpalash1990-a11y/E-comerce-/issues/86#issuecomment-6622745237): Arena reserved customer order reads and method dispatch for this PR. Jules retains remaining backend route parity, cart/coupon/admin configuration, provider integration and production verification.
- [Queen issue #87](https://github.com/mohammedpalash1990-a11y/E-comerce-/issues/87#issuecomment-6622745490): Queen retains frontend files, reconciliation of canonical/served designs, account/checkout/tracking integration and browser acceptance tests.
- Arena/coordinator: independent audit, this backend slice, test evidence, contract and review handoff.

These are task handoff comments, not a claim that an external agent has accepted or executed them. No verified agent account was available to set as GitHub assignee.

## Prioritized implementation plan and outcome

1. **P0 — Preserve and verify baseline:** done. Baseline `npm run check`: 237 passed, 0 failed, 7 skipped without PostgreSQL.
2. **P0 — Repair unreachable domain write routes:** done. Dispatcher previously picked the first path match (often GET) and returned 405 before considering later POST/PUT/DELETE handlers. It now selects path **and** method, retains role enforcement, and sends an `Allow` header for unsupported methods.
3. **P1 — Complete PostgreSQL customer order reads:** done for the API scope below, including mounted HTTP routes, owner/role boundaries and real-database tests.
4. **P1 — Reproducible installs, contract and QA:** done. Committed npm lockfile; primary CI uses `npm ci`; OpenAPI extended and validated. No runtime dependency added.
5. **P0 next — Reconcile frontend/runtime integration and verify actual HTTP checkout:** open; coordinate with #91, #86 and #87. Keep production gate closed.
6. **P1/P2 next — Remaining admin settings, provider adapters, mobile apps and operational acceptance:** open; see the matrix and deployment guide.

## Implemented API contract

Both endpoints require a valid active CUSTOMER bearer session. Seller/admin roles get 403; missing, expired, revoked or suspended sessions get 401. Foreign and nonexistent orders share the same opaque 404. Malformed percent encodings return 400. IDs are bound SQL parameters; the shortened display order number is not a lookup key.

### `GET /api/v1/customer/orders/:id`

Returns `{ data: ... }` containing:

- ID, display order number, status, creation time and coupon code;
- total/subtotal/shipping/discount BDT values converted from persisted integer paisa;
- payment method/status and the customer's own delivery information/note;
- purchased item name/quantity/unit price/variant snapshots, not current catalog prices;
- seller sub-orders with shop label, status, subtotal, and latest shipment (or `null`).

Latest shipment selection orders by `created_at DESC, id DESC`, including a deterministic tie-breaker. Item `seller_order_id` links multi-vendor items to their sub-order. Shipment `mode` is explicit so sandbox data cannot be mistaken for live courier fulfilment.

### `GET /api/v1/customer/orders/:id/tracking`

Returns display order number, status, status/timestamp/sub-order events, and all stored shipments. Events and shipments are ordered by creation time then ID. It reads existing records; it neither calls a courier nor fabricates an ETA or tracking status.

### Privacy and consistency

- Customer ownership is checked **before any child-table read**.
- A read-only repeatable-read transaction gives each response one consistent database snapshot.
- Explicit response allowlists omit admin notes, free-text operational event notes, actor IDs, commissions, seller net earnings, shipment charges, raw payment data and gateway references.
- The existing SQLite tracking route exposes event notes. The new PostgreSQL route intentionally does **not**: there is no audited customer-public message field yet. Frontend consumers must render the structured status timeline without depending on `event.note`.
- Order detail includes the customer's own delivery note; this is distinct from internal event/admin notes.
- Production startup, database schemas, existing checkout/cancel handlers and business prices remain unchanged.

See `openapi.yaml` for request/response schemas. It is still a partial whole-platform contract, not documentation of every existing route.

## Test evidence

Environment: Node 22.22.3. A disposable local **PostgreSQL 18.6, UTF-8** server was started using npm-distributed binaries outside the repository. No existing/production database or credentials were used. The repository CI targets PostgreSQL 16; local 18.6 results do not substitute for that CI result.

| Check actually run | Result |
| --- | --- |
| Baseline `npm run check`, before code changes, no PG test URL | 237 pass, 0 fail, 7 skip |
| New customer-order route unit tests | 7 pass |
| PostgreSQL server test file, including dispatch/authorization regression cases | 20 pass |
| New real-PostgreSQL HTTP test file | 7 pass (parent plus 6 subtests) |
| `npm ci --no-audit --no-fund` using committed lockfile | Pass |
| Full `npm run check` with disposable `POSTGRES_TEST_DATABASE_URL` and `PGSSL_MODE=disable`, after clean install | **261 pass, 0 fail, 0 skip** |
| Existing canonical Playwright suite, npm-distributed headless Chromium | **7 pass**, includes 390px mobile / 1440px desktop grid checks |
| OpenAPI 3.0 validation with `@apidevtools/swagger-parser` | Pass, 7 documented paths |
| `npm run db:migrate:postgres` against the migrated disposable database | Pass — 6 migrations recorded, 0 reapplied |
| `git diff --check` and new route `node --check` | Pass |

The full check includes syntax/repository checks, API/integration tests, migration ledger/checksum/idempotence tests, real database auth/catalog/inventory tests, security boundaries and production-startup guards. There is no separate compiled application build script.

New live HTTP coverage includes actual login/session lookup, multi-vendor order detail, owner isolation, invalid/SQL-looking IDs, sandbox tracking labels, note/privacy redaction, seller POST/PUT/DELETE with role and ownership checks, audit writes, customer cancellation/stock restoration and suspended/revoked sessions. The test creates an order through the checkout **repository with an explicit test-only shipping callback**, not through the still-blocked HTTP checkout composition. Shipment rows are test fixtures, not a courier integration.

### Failures encountered and resolved

- First browser run: all seven tests failed at **browser launch**, due to missing `libnspr4.so`/NSS libraries. Supplied the browser package's matching libraries outside Git; rerun passed all seven. Test-only config used an alternate executable and disabled video; no assertions or application files were changed. This is not Safari/iOS/Android validation.
- First OpenAPI validation caught unquoted commas in inline YAML response descriptions. Fixed the descriptions and reran validation successfully.
- No unresolved application test failures were observed in the final local suite. Browser coverage remains the canonical demo only, not the full live marketplace journey.

## Changed files

| File | Change |
| --- | --- |
| `apps/api/src/postgres-customer-order-routes.mjs` | New customer detail/tracking projections and snapshot transactions |
| `apps/api/src/postgres-server.mjs` | Mount customer routes; method-aware domain dispatch and Allow header |
| `tests/postgres-customer-order-routes.test.mjs` | Deterministic projection/privacy/transaction/ownership unit tests |
| `tests/postgres-customer-orders.integration.test.mjs` | Real PostgreSQL + HTTP workflow, roles, isolation, cancellation and product write regression tests; fixture cleanup |
| `tests/postgres-server.test.mjs` | Always-running HTTP dispatch, auth, role, malformed-path and method tests |
| `openapi.yaml` | Customer order and tracking endpoint contracts/schemas |
| `package-lock.json` | Reproducible existing pg dependency tree |
| `.github/workflows/ci.yml` | Use locked `npm ci` installation |
| `README.md` | Current-state pointers and corrected PostgreSQL/runtime guidance |
| `docs/DEPLOYMENT.md` | Current private staging/test instructions, limitations and rollback procedure |
| `docs/DEVELOPMENT_REPORT_2026-11-04.md` | This audit, contract, test evidence and remaining work |

## Verified completion rubric

There is no pre-existing weighted acceptance backlog for all requested features, so a precise universal project percentage would be invented. This delivery uses **30 explicit, equally weighted development acceptance checks** below. Only fully verified checks receive credit; partial/unverified checks receive zero. This yields **10 / 30 = 33.3% verified development acceptance**. It is **not 33.3% production readiness**, an estimate of code written, or a claim that the ten verified areas have all production requirements satisfied. Production launch remains blocked.

| # | Acceptance check | Status / evidence or next work |
| --- | --- | --- |
| 1 | Canonical demo homepage/discovery/search/category behavior | VERIFIED — existing browser + Node tests |
| 2 | Canonical demo cart quantities and local persistence | VERIFIED — browser tests |
| 3 | Canonical demo mobile/desktop grid usability | VERIFIED — 390px/1440px browser checks |
| 4 | PostgreSQL migration ledger, checksums, idempotence | VERIFIED — full real DB suite |
| 5 | PostgreSQL registration/login/session lifecycle primitives | VERIFIED — real DB auth and HTTP tests; delivery providers excluded |
| 6 | Tested customer-order/seller-product role and ownership boundaries | VERIFIED — new HTTP tests; not a platform penetration test |
| 7 | PostgreSQL inventory adjustment approval/concurrency workflow | VERIFIED — existing real DB integration test |
| 8 | Seller product submit/edit/archive via PostgreSQL HTTP | VERIFIED — new live HTTP test |
| 9 | Customer order detail/tracking PostgreSQL HTTP | VERIFIED — new unit + live HTTP tests |
| 10 | Multi-vendor COD cancellation and stock restoration | VERIFIED — new live HTTP test and existing lifecycle tests |
| 11 | Unified canonical frontend with live product discovery/filtering | PARTIAL — reconcile served/root storefronts |
| 12 | Customer account/dashboard frontend | PARTIAL — current account page absent; recover/review historical work |
| 13 | Wishlist, addresses, reviews in complete browser journeys | PARTIAL — backend exists; integrated UI acceptance needed |
| 14 | End-to-end HTTP cart/coupon/shipping/checkout | BLOCKED — missing PG cart/coupon route parity and shipping composition |
| 15 | Vendor onboarding/verification/storefront browser journey | PARTIAL — existing auth/approval backend; verify complete UX |
| 16 | Seller earnings, withdrawals, reports end to end | PARTIAL — routes exist; accounting/concurrency and UI acceptance remain |
| 17 | Complete admin customer/catalog/order/payment/refund management | PARTIAL — several PostgreSQL counterparts absent |
| 18 | Owner-configurable commission/delivery/business settings | PARTIAL — no complete settings system; existing defaults need owner review |
| 19 | Promotions/coupons and real notification delivery | PARTIAL — stored records/development endpoints, no delivery-provider acceptance |
| 20 | Subcategories, production media uploads/storage and rich catalog | PARTIAL — basic categories/image URLs, not full production media pipeline |
| 21 | District/upazila validation and complete Bengali/English localization | OPEN — Bengali-first UI is not complete bilingual/local-address support |
| 22 | Licensed live payment integration and verified callbacks | OPEN — sandbox adapters/contracts only |
| 23 | Live courier handoff, tracking and reconciliation | OPEN — sandbox/stored records only |
| 24 | Returns, disputes, refunds and support operations end to end | OPEN — full acceptance missing |
| 25 | Android app | OPEN — no native app in checkout |
| 26 | iOS app | OPEN — no native app in checkout |
| 27 | Production API/frontends hosted with safe configuration | BLOCKED — runtime guards intentionally enabled |
| 28 | Independent production security/privacy/legal acceptance | OPEN — regression tests are not a complete security audit |
| 29 | Backups, restore drill, monitoring and incident readiness | OPEN — operational evidence missing |
| 30 | Load/performance/accessibility/full-browser acceptance and complete API docs | PARTIAL — limited suite/contract; no load test or full live journeys |

## Deployment blockers / next review

Do not merge or enable production based only on this test suite. Review #91 separately; validate the final fee/commission settings with the owner. Finish PostgreSQL cart/coupon/shipping/admin/refund/payment/courier parity, reconcile frontend routing and contracts, and run browser journeys against staging PostgreSQL. Add OTP delivery, durable provider webhook/idempotency handling, production media, multi-instance rate limiting, observability, backup/restore evidence and independent security review. Native Android/iOS work remains separate.

This PR needs a normal review, CI on its exact head and explicit owner approval before any merge. Older overlapping PRs should be reviewed individually, not batch-merged.
