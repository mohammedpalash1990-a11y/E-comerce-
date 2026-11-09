# HAAT — Launch Readiness Audit (2026-11-09)

## Scope and evidence boundary

This is a repository-state audit, not a production approval. It was prepared from GitHub's current `main`, open pull requests, active branch refs, the current deployment guide, root README, production PostgreSQL entrypoint, CI workflow and the existing 30-check acceptance rubric in `docs/DEVELOPMENT_REPORT_2026-11-04.md`.

- Repository: `mohammedpalash1990-a11y/E-comerce-`
- Audited base branch: `main`
- Audited base SHA: `4f85a9a8cdbf03a99f93efb75b8cc57b16452bc6`
- Audit date: 2026-11-09
- This PR changes documentation only. PRs #112, #111 and #110 were separately reviewed, tested and merged into `main`. No production database or PostgreSQL API service was touched; the existing GitHub Pages static-preview workflow completed successfully on the audited main SHA.

## Current launch verdict

**NOT PRODUCTION READY. Keep the production startup guard enabled.**

The repository contains a working static preview, SQLite development runtime, and a separately composed PostgreSQL development API. GitHub Pages does not host the API. The PostgreSQL API deliberately throws when `NODE_ENV=production`; the guard cites incomplete live HTTP/commerce verification, production payment/courier adapters, backup/restore and deployment security checks. Do not bypass this guard or point the API at live customer data.

The current README and deployment guide are the authoritative high-level warning. Some older paragraphs in `docs/STATUS_BN.md` describe earlier SQLite-only states and conflict with newer PostgreSQL work; treat the latest section of that file and the current README/deployment guide as the more recent descriptions. Consolidate the historical status document before launch.

## Verified repository state

### Runtime and storefront

- Root `index.html` is the canonical static storefront baseline used by the canonical browser workflow.
- `apps/web/public/index.html` is a separate API-backed served storefront. The README explicitly warns that the two are not identical. Do not overwrite either or declare the design integration complete without a reviewed reconciliation and browser acceptance.
- `npm run start:api` launches the SQLite demo runtime; `npm run start:api:postgres` launches the isolated PostgreSQL development runtime.
- `npm run db:migrate:postgres` applies ordered PostgreSQL SQL migrations under a database advisory lock.
- The repository CI workflow provisions PostgreSQL 16 and runs `npm ci` followed by `npm run check`. The separate canonical storefront workflow tests the static storefront, not live marketplace journeys.

### PostgreSQL composition

The explicit PostgreSQL server currently mounts catalog, auth, customer account/order, cart, coupon, commerce, inventory, payment, seller workspace/product/courier, admin seller/product/order/dashboard, and payout route modules. The admin dashboard module now also exposes an ADMIN-only read-only financial summary endpoint with Asia/Dhaka date boundaries and paisa-safe aggregates. Seller-scoped shipping and refunds are deliberately `null` until the schema supports seller-level allocation. This is meaningful development coverage, but mounting a route is not proof that every flow is production-ready. HTTP checkout/shipping, payment settlement/webhooks, live courier handoff, financial reconciliation and operational recovery still require end-to-end evidence.

OTP security must remain unchanged while closing remaining gaps: preserve transaction/row locking, the failed-attempt ceiling, expiry validation, single-use/replay rejection and concurrency tests. Do not introduce a second authentication implementation.

## Open PR and branch coordination snapshot

The following table lists currently open PRs. Merged integration evidence and exact verification results since the prior snapshot are recorded first.

### Merged since the previous snapshot

| PR | Integration | Exact-head evidence |
| --- | --- | --- |
| [#112](https://github.com/mohammedpalash1990-a11y/E-comerce-/pull/112) | Real PostgreSQL migration concurrency, rollback and checksum tests; merge commit `a4d9a6ff9de89400ed3d4e81411113c86b8abd62` | CI: 423 passed, 0 failed, 0 skipped; canonical storefront Playwright passed. Uses isolated schemas on disposable PostgreSQL 16. |
| [#111](https://github.com/mohammedpalash1990-a11y/E-comerce-/pull/111) | ADMIN-only PostgreSQL financial summary; merge commit `6712431c606c4304d27e189d5af191344b114417` | Exact-head CI: 428 passed, 0 failed, 0 skipped; canonical storefront Playwright passed. Seller-scoped refunds are `null` until refund amounts can be allocated to seller sub-orders. |
| [#110](https://github.com/mohammedpalash1990-a11y/E-comerce-/pull/110) | Coupon cancellation restoration regression and deterministic inventory integration fixtures; merge commit `4f85a9a8cdbf03a99f93efb75b8cc57b16452bc6` | Exact-head CI: 429 passed, 0 failed, 0 skipped; canonical storefront Playwright passed. This fixed the inventory test's notification/user foreign-key race exposed on the intermediate #111 merge commit. |

Current `main` at `4f85a9a8cdbf03a99f93efb75b8cc57b16452bc6` has CI green (429 passed, 0 failed, 0 skipped), canonical storefront Playwright green, and GitHub Pages build/deployment green. These checks do not validate production API readiness.

### Currently open PRs

| PR | Current scope | Coordination / disposition |
| --- | --- | --- |
| [#113](https://github.com/mohammedpalash1990-a11y/E-comerce-/pull/113) | This launch-readiness audit | Draft documentation-only PR; this revision rebases the audit onto current main and refreshes merged/open work evidence. |
| [#97](https://github.com/mohammedpalash1990-a11y/E-comerce-/pull/97) | Coupon redemption controls, customer cart/coupon/order wiring | Draft; head `6b12411524e5eb4c039e17a6e6e6b1bb3476a167` still targets the old main base `34f3ee7548913e6a1196caa01b2ac5f2ad735d3a`. Its recorded head CI and storefront checks passed, but rebase and rerun against current main before integration. |
| [#19](https://github.com/mohammedpalash1990-a11y/E-comerce-/pull/19) | Seller/Admin workspace PostgreSQL migration | Draft and stacked on `feature/postgres-customer-account-domain` at `17710d8dde39842d293ec442b77cde5c3c6cddd5`; its recorded CI passed, but it is not a direct-main PR. Reconcile its dependency stack first. |

Other branch refs cover auth/OTP, PostgreSQL runtime/bootstrap, catalog, seller/admin, inventory, security headers, payment, courier, accessibility and storefront search. The current bounded `work/` refs own these files: `work/customer-address-default-invariants` → `tests/postgres-customer.test.mjs`; `work/extract-sqlite-independent-product-image-validation` → PostgreSQL auth/shared helpers and `tests/postgres-shared.test.mjs`; `work/marketplace-cors-origin-edge-tests` and `work/marketplace-production-entrypoint-guard-test` both target `tests/postgres-server.test.mjs`; `work/production-runtime-gate-regression-20261104` → `tests/postgres-production-runtime-guard.test.mjs`. Do not edit those agent-owned files in parallel. The intermediate `arena/coupon-cancellation-real-pg-test` and `arena/inventory-idempotency-real-pg` refs still exist, but their fixture work was consolidated into merged PR #110; do not restart duplicate work from those refs. Inspect branch head and changed-file ownership before starting work in any other area.

## Dependency-ordered completion plan

The following sequence is the remaining launch plan. Complete each gate with code review, focused tests, full repository checks, exact-head CI and evidence before starting dependent production work.

### Gate 0 — Integrate and stabilize existing work

1. Re-check current main, all open PRs, branch heads, changed files and exact-head workflow runs.
2. Rebase PR #97 from its stale base and resolve coupon/cart integration conflicts without replacing existing checkout or auth modules.
3. Resolve the stacked seller/admin workspace chain in PR #19 only after its dependency PRs are understood.
4. Coordinate the active `work/` refs by file ownership; do not create duplicate CORS, production-guard, customer-address or PostgreSQL shared-helper tests.
5. Re-run the complete suite after each integration; preserve the canonical storefront and OTP invariants.

### Gate 1 — Production PostgreSQL API completeness

1. Build a route-to-repository-to-migration coverage matrix for every customer, seller and admin endpoint.
2. Verify PostgreSQL-only startup has no static or transitive SQLite imports, SQLite seed side effects, or SQLite fallback.
3. Verify every required migration against a disposable PostgreSQL 16 database, including clean install, upgrade, repeat application, rollback behavior and checksum drift detection.
4. Complete HTTP cart → shipping quote/policy → checkout → order → inventory reservation → cancellation/refund lifecycle tests with real PostgreSQL.
5. Verify ownership/role boundaries, transaction isolation, idempotency, concurrency and error handling for all write routes.
6. Keep `NODE_ENV=production` startup fail-closed until every required route, migration and deployment dependency has explicit passing evidence.

### Gate 2 — Money, payment and delivery

1. Freeze and document owner-approved BDT/paisa rules for seller commission, platform fees, shipping, discounts, refunds, COD and payout eligibility.
2. Verify commission ledger postings and reversals against seller sub-orders; enforce idempotent settlement and payout state transitions.
3. Implement provider-specific payment adapters only after the selected Bangladesh providers, merchant credentials, callback URLs and sandbox accounts are supplied and approved.
4. Verify webhook signatures, timestamp/replay protection, idempotency keys, duplicate delivery, out-of-order callbacks, reconciliation and refund settlement.
5. Implement the selected courier adapter after provider credentials and serviceability/fee rules are approved; verify booking, label/tracking updates, failed delivery, return-to-origin and COD remittance reconciliation.
6. Never label sandbox payments or courier records as live integrations.

### Gate 3 — Seller and Admin operations

1. Complete seller application, KYC/document review, approval/suspension and seller-owned product/inventory controls.
2. Complete admin moderation, seller/customer management, order operations, refund decisions, payout review, audit log and configurable platform settings. The read-only financial summary API is present; it does not provide a bilingual reporting UI or a refund allocation/settlement workflow.
3. Add CSV/report exports only after financial calculations, seller attribution and permission boundaries are verified.
4. Verify seller isolation and admin role boundaries with real PostgreSQL HTTP tests and audit records.

### Gate 4 — Customer experience and localization

1. Reconcile root canonical storefront with the API-backed served storefront through a deliberate, reviewed integration; retain current visual behavior.
2. Complete account, addresses, wishlist, reviews, order tracking, cancellation/return and notifications in actual browser journeys.
3. Complete Bengali and English translation coverage, Bangladeshi phone/address validation (division/district/upazila), BDT formatting and accessible language switching.
4. Validate responsive behavior at small mobile, tablet and desktop widths; keyboard navigation, focus, contrast, screen-reader labels, empty/error/loading states and reduced motion.
5. Run browser E2E against the real staging API and disposable/staging PostgreSQL, not only the static preview.

### Gate 5 — Operational and legal launch controls

1. Provision production API hosting, managed PostgreSQL, TLS, secret management, exact CORS allowlist, trusted proxy configuration and shared multi-instance rate limiting.
2. Remove development seed accounts and rotate all credentials/secrets. Verify session revocation, password reset, OTP delivery and recovery.
3. Configure encrypted automated backups and complete a timed restore drill into an isolated environment.
4. Add structured logs, metrics, alerting, uptime checks, incident response, rollback and on-call ownership.
5. Complete dependency/security scanning, independent penetration test, privacy/data-retention review, Bangladesh consumer-protection/tax/legal review and provider contractual approval.
6. Complete load, performance and accessibility acceptance with recorded results.
7. Only then review the production startup gate for removal through a separate, evidence-backed PR and an explicit owner approval.

### Gate 6 — Native apps (separate release track)

Android and iOS are not delivered by the current web repository. Treat native apps as a separately scoped release after stable API contracts, authentication, payments and customer journeys are production-accepted. Do not count the static PWA preview as native Android/iOS completion.

## Measurable progress rule

The existing development report defines 30 equally weighted acceptance checks, with 10/30 previously marked verified (33.3% development acceptance, not production readiness). This audit does not independently rerun all 30 checks, so it does not increase that score. Recalculate only after each acceptance criterion is verified against current main and evidence is attached. Production readiness is a separate binary gate: **blocked** until all required production controls pass.

## Required evidence for every future implementation run

Record:
- base branch and full base SHA;
- branch name and final commit SHA;
- exact changed files and why they do not overlap agent-owned files;
- focused tests and full repository check pass/fail/skip counts;
- disposable PostgreSQL version and integration result, or explicit blocked reason;
- exact-head CI and canonical storefront browser workflow URLs;
- PR URL, mergeability/conflict state and review status;
- remaining blockers and the next dependency-ready task.

Never claim a feature is complete because a module exists, a PR is open, or a static preview renders. Never merge or deploy based on stale CI from a different SHA.
