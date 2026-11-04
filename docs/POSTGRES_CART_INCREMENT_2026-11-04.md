# PostgreSQL customer cart increment — 2026-11-04

Continuation of [PR #92](https://github.com/mohammedpalash1990-a11y/E-comerce-/pull/92) on `arena/0ce94763-e-comerce`, after the order-read/dispatch delivery at `efb68fd`. The cart API increment is implemented and locally tested; **the marketplace is not production-ready**. No merge, deployment, provider integration or pricing-policy decision is included.

## Existing work reused and coordination

Before implementing, rechecked the working tree, open PRs and Jules issue #86. Reviewed the cart code in older PR #6 (`feature/postgres-inventory-checkout-payments`) and the overlapping #27 stack. Adapted its `getCart`, `setItemQuantity`, `removeItem`, `clearCart` design and unavailable-line behavior into a small isolated module. Did not import the old SQLite-coupled route composition, replace the newer checkout repository, or merge an old stack wholesale.

The [scope handoff on #86](https://github.com/mohammedpalash1990-a11y/E-comerce-/issues/86#issuecomment-6622987028) reserves cart parity and the minimum cart/checkout concurrency fixes for Arena. Shipping PR #91, coupons, admin settings and providers remain separate. Queen retains frontend files and account/cart/checkout UX integration. No external agent execution is claimed.

## Implemented

- `GET /api/v1/customer/cart`: read the authenticated customer's saved lines.
- `PUT /api/v1/customer/cart`: set an **absolute** line quantity, not an additive increment.
- `DELETE /api/v1/customer/cart/:pid`: idempotently remove one owned line.
- `DELETE /api/v1/customer/cart`: clear only the authenticated customer's cart.
- All four routes are CUSTOMER-only; client-supplied user IDs and prices do not determine ownership/pricing.
- Validate quantities as integer numbers or digit-only form strings, 0–1000. Reject null, booleans, blank strings, arrays, fractions and unsupported numeric notation. Zero deliberately removes the line, including unavailable products.
- Enforce at most 50 distinct saved products, matching the existing checkout limit. Count unavailable saved products too; existing lines remain editable and removable at the limit.
- Only visible ACTIVE products from APPROVED seller profiles accept positive quantities, with current-stock validation. Cart edits **do not reserve or deduct inventory**.
- Saved unavailable lines remain visible with `available: false`, following the earlier PostgreSQL cart design, rather than silently disappearing. Current prices are estimates, not guaranteed checkout prices.
- Sum validated integer paisa before conversion to BDT. Fail closed on unsafe/negative persisted numbers or arithmetic overflow.
- No schema changes, new runtime dependencies, frontend changes or business-price changes.

## Frontend contract

All operations return HTTP 200 with `{ data: { items, subtotal_bdt, item_count } }` on success.

Each item contains `product_id`, `name_bn`, `name_en`, `quantity`, `stock`, nullable `image`, `unit_price_bdt`, `line_total_bdt`, and `available`. `item_count` is the sum of quantities, not the count of distinct products. Subtotal includes unavailable saved lines: it is a cart estimate, **not** a payable total or shipping quote. Checkout must still revalidate stock, prices, seller eligibility, coupons and shipping.

Example PUT body: `{ "productId": "internal-product-id", "quantity": 2 }`.

Errors: 400 invalid input/encoding, 401 invalid/inactive session, 403 wrong role, 404 missing/unavailable product for positive quantity, 409 insufficient stock or new-line cap reached. Unsupported methods retain the existing 405/Allow behavior. Errors do not overwrite the previously saved line. DELETE and quantity zero do not require the product to remain purchasable.

See `openapi.yaml` for schemas. The default SQLite API remains unchanged; these are routes on the explicit PostgreSQL development entrypoint.

## Checkout fixes required by the cart handoff

1. **PostgreSQL alias correctness:** unquoted `productId` was folded to `productid`, so checkout failed to recognize saved product IDs. The select now uses `AS "productId"` and deterministic product ordering.
2. **Transactional cart snapshot:** previously checkout read the saved cart before beginning its transaction, then deleted the cart after order creation. An edit between those operations could be lost, and concurrent checkouts could consume the same snapshot.
3. **Shared lock ordering:** cart writes and checkout now lock the active CUSTOMER user row first, before product/cart operations. Checkout reads and clears cart lines in the same transaction. Explicit-item checkout also takes the lock because it removes corresponding saved cart lines.
4. **No blanket idempotency claim:** two simultaneous **cart-backed** checkouts now serialize; the second sees an empty cart and is rejected. Repeated explicit-item checkout requests still need a separate idempotency-key design.

The live test observes a real `pg_stat_activity` lock wait while a checkout is paused after stock/pricing reads. A concurrent HTTP cart edit waits, then remains saved after checkout cleanup. A separate injected failure after cart cleanup verifies rollback of cart deletion, stock reservation and order/payment writes together.

## Verification actually run

Local environment: Node 22.22.3 and disposable PostgreSQL 18.6 / UTF-8, with no production connection. Browser executable/libraries are test-only files outside Git.

| Check | Result |
| --- | --- |
| Cart unit + checkout + server tests, before late-failure integration case | 40 pass, 0 fail |
| Initial real cart HTTP/concurrency test file | 9 pass (parent plus 8 subtests), 0 fail |
| Clean `npm ci --no-audit --no-fund` | Pass |
| Final full `npm run check` with disposable PostgreSQL, including added late rollback test | **285 pass, 0 fail, 0 skip** |
| Existing canonical Playwright browser suite | **7 pass**, including mobile/desktop checks |
| OpenAPI validation using `@apidevtools/swagger-parser` | Pass, 9 documented paths |
| Migration CLI against the disposable database | Pass — 6 recorded, 0 reapplied |
| New module syntax checks and `git diff --check` | Pass |

The final full suite includes **24 additional passing tests** compared with the previous 261-test increment: 11 cart unit/route tests, 2 checkout tests, 1 HTTP server boundary test, and 10 real-cart integration results (parent plus 9 subtests). Existing order and security tests remain passing.

No failures were observed in these increment test runs. Browser tests still cover the canonical **static demo**, not the new live cart UI or a complete customer checkout journey. Real cart-to-checkout tests call the checkout repository with an explicit **fixture-only shipping callback**; they do not enable HTTP checkout or integrate PR #91. Missing-policy rejection is tested independently so these tests do not require #91 to remain unmerged forever.

## Files changed in this increment

- `apps/api/src/postgres-cart.mjs`: isolated cart repository, validation, exact money and serialized mutations.
- `apps/api/src/postgres-cart-routes.mjs`: four customer routes and explicit BDT projection.
- `apps/api/src/postgres-server.mjs`: mount cart routes without changing shipping or production guard.
- `apps/api/src/postgres-checkout.mjs`: quoted product alias, owner lock and in-transaction cart read.
- `tests/postgres-cart.test.mjs`: repository/route contract, limits, isolation, errors and money tests.
- `tests/postgres-cart.integration.test.mjs`: real HTTP lifecycle, cap race, checkout handoff, lost-edit protection, duplicate-cart-checkout protection and late rollback.
- `tests/postgres-checkout.test.mjs`: adapt fake owner lookup; guard lock/alias ordering and inactive owner behavior.
- `tests/postgres-server.test.mjs`: mounted cart role/method/encoding boundaries.
- `openapi.yaml`: cart operations and response schemas.
- `README.md`, `docs/DEPLOYMENT.md`, `docs/DEVELOPMENT_REPORT_2026-11-04.md`: current-state links and rollout/historical-snapshot clarification.
- `docs/POSTGRES_CART_INCREMENT_2026-11-04.md`: this handoff and verification report.

## Rollout and remaining work

No migration/backfill is required. For private staging, drain/stop API instances before replacing them so old checkout writers cannot bypass the new customer-lock protocol. Deploy the cart and checkout changes together. Roll back by redeploying the previous approved API version without deleting data; rollback loses the new cart endpoints and concurrency protections. Never bypass the production startup guard.

Next priorities: review shipping-policy #91 independently, finish server-authoritative coupon validation and wiring, integrate the canonical/customer frontend with this cart contract, and test complete browser checkout on staging. Editable business policies, remaining admin flows, live providers, mobile apps and operational/security acceptance remain outstanding.

The earlier 30-check rubric is unchanged at **10/30 verified development checks (33.3%)** because its checkout criterion combines cart, coupons, shipping and end-to-end acceptance. Cart is now implemented, but that whole criterion is not yet complete. This avoids inflating completion by counting a partially finished workflow as launch-ready.
