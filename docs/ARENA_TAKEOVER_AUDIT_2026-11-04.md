# Arena takeover audit — 2026-11-04

## Scope

This audit takes over issue #96 from the existing Arena increment. It checks the remaining coupon/order-accounting items named in PR #92 and the current PostgreSQL branch. This is an audit record, not a completion claim.

## Branch alignment

- Current main: `039fe5164065c9c93e31c4732c627733e7e733e9` (includes the shipping-policy merge from PR #91).
- Arena increment head: `6931f9c1e1b886f1bf3bafb6c7203f91814f2803`.
- Comparison: Arena branch is 5 commits ahead and 2 commits behind main; it diverged at `bda1453374ee7b5e189f9418cb94a054d9290f19`.
- Therefore the Arena increment must be synchronized with current main before its work can be considered integration-ready. Do not merge or deploy this branch as-is.

## Confirmed gaps

### 1. Coupon discount allocation across seller sub-orders — MISSING

In `apps/api/src/postgres-checkout.mjs`, the coupon discount is applied to the parent `orders.discount_paisa` and the parent total. Seller sub-orders are still created using each seller's gross subtotal, commission and net amount; no per-seller coupon allocation or funding ledger is written. This leaves seller-level settlement/reporting unable to explain who funded the parent discount.

**Implementation blocker:** the repository does not define whether coupon discounts are platform-funded, seller-funded, or mixed. Do not silently invent a funding policy. The implementation must record deterministic per-seller allocations and an explicit funding source once the business rule is confirmed/documented.

### 2. Per-customer coupon usage limits — MISSING

The current PostgreSQL `coupons` schema exposes global `max_uses` and `used_count` only. `createPostgresCouponRepository.validateCoupon` checks global exhaustion but does not receive a customer ID or query customer-specific redemption history. The admin coupon create/list contract also has no per-customer limit field.

### 3. Coupon usage restoration on full cancellation — MISSING

Checkout increments `coupons.used_count` in the same transaction as order creation. `apps/api/src/postgres-orders.mjs` handles cancellation, inventory restoration and refund requests, but it does not reverse coupon usage or persist a redemption row that can be safely reversed exactly once. Partial seller cancellation must not restore the parent coupon use; only a fully cancelled parent order should do so.

## Existing work verified

- PR #92 already contains customer order detail/tracking, saved cart, coupon preview and checkout redemption, admin coupon list/create/activation, and customer address/wishlist/review routes.
- PR #92 reports a disposable PostgreSQL run with 354 passed, 0 failed, 0 skipped and OpenAPI validation for 17 paths. Its newest browser suite was not run in that environment; the previous storefront browser result was 7/7 at `c7c3cd0`.
- PR #92 explicitly lists the three coupon gaps above as remaining.
- The PostgreSQL server already mounts admin coupon, admin seller/product/order/dashboard and payout API route modules on the Arena branch. This audit does not treat their existence as proof that the corresponding admin browser UI is complete.
- PR #92 documents the canonical-vs-served storefront mismatch: root `index.html` is the canonical static demo while the Node server/Pages workflow serves `apps/web/public/index.html`. This is a frontend/build ownership item and must not be “fixed” by overwriting either file during this backend task.

## Required next implementation slices

1. Define and document coupon funding ownership before changing seller payout math.
2. Add a forward-only PostgreSQL migration for customer-specific coupon limits and durable redemption records; keep existing coupon rows valid.
3. Make preview and checkout enforce the same per-customer limit, with checkout locking/transaction semantics that prevent concurrent over-redemption.
4. Allocate each parent coupon discount deterministically across seller sub-orders and persist the allocation/funding source.
5. Restore a coupon use exactly once only when the entire parent order reaches `CANCELLED`; preserve usage on partial seller cancellation and handle legacy orders with no redemption record safely.
6. Add disposable real-PostgreSQL integration tests for multi-customer limits, concurrent checkout, proportional allocation/remainder handling, partial cancellation, full cancellation and repeated cancellation.
7. Synchronize the implementation branch with current main, run the full CI suite and canonical browser tests where tooling is available, then submit a focused PR. Do not merge or deploy without verified checks.

## Verification limitations

Repository file inspection and commit comparison were performed through GitHub. A local clone could not be obtained because this execution environment could not resolve `github.com`; no local test command was run for this audit. No production database, live payment provider, customer data or deployment was touched.
