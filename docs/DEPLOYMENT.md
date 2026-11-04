# Deployment guide

## 1. Local development
Requirements: Node.js 22.5+ and npm.

```bash
cp .env.example .env
npm ci
npm run dev
```

The development launcher serves the storefront and API locally. The SQLite database is for development only.

## 2. GitHub Pages preview
GitHub Pages hosts only static files. It does not execute the Node.js API, SQLite database, sessions, or payment/courier adapters. Customer login, seller actions, admin actions and checkout will not work on Pages alone.

## 3. Private development / staging API — not a production release

There are two explicit runtimes. `npm run start:api` is the seeded SQLite demo;
`npm run start:api:postgres` is the isolated PostgreSQL development runtime.
`DATABASE_URL` **is consumed** by the PostgreSQL entrypoint. Neither runtime is
approved for production and both reject `NODE_ENV=production`.

1. Use Node 22.5+ and `npm ci`. Supply environment variables through the process
   environment or Node's `--env-file` support; copying `.env` alone does not load it.
2. Use a **disposable** PostgreSQL database for tests. Never point
   `POSTGRES_TEST_DATABASE_URL` at production: tests apply migrations and create
   and remove fixtures.
3. Set `DATABASE_URL` from a secret manager and `PGSSL_MODE=require` for a remote
   database, with certificate verification enabled. Only a disposable local test
   server should use `PGSSL_MODE=disable`.
4. Run `npm run db:migrate:postgres` with the configured database. Review the
   migration ledger/checksums; do not edit already-applied SQL. The PostgreSQL
   entrypoint also auto-migrates unless `PG_AUTO_MIGRATE=0`.
5. For a private development service, start with `NODE_ENV=development`,
   `HOST=0.0.0.0`, `PORT=4000`, then `npm run start:api:postgres`. This is not a
   workaround for launching publicly with the production gate disabled. No demo
   account seed is imported by this PostgreSQL entrypoint.
6. Start `npm run start:web` with `WEB_PORT=3000`, `PORT=4000` and backend
   `API_HOST` pointing to the API service. Browser requests use same-origin
   `/api/*`; do not configure browser-facing localhost URLs in a hosted preview.
7. Configure exact browser origins in `CORS_ORIGINS`, including the staging
   frontend origin when necessary. Do not use wildcard origins.
8. Check API `/health`, run authentication/authorization and real PostgreSQL
   tests, and then verify browser journeys. The current web/Pages storefront
   differs from the root canonical demo; see the current report before deployment.

### Verification commands

After exporting `POSTGRES_TEST_DATABASE_URL` for a disposable database and its
appropriate `PGSSL_MODE`:

```bash
npm ci --no-audit --no-fund
npm run check
node --test tests/postgres-customer-orders.integration.test.mjs
```

`npm run check` runs syntax/repository checks and the full Node test suite. Without
`POSTGRES_TEST_DATABASE_URL`, real-database tests report skips rather than passes.
The existing browser workflow installs Playwright/Chromium and runs
`npx playwright test`; it currently covers the canonical static storefront, not
live customer/seller/admin end-to-end acceptance.

### This increment's rollout and rollback

The customer-order, cart and coupon increments need **no schema migration** or
data backfill. They do not select new commission, shipping or discount amounts. Deploy only
to private staging after review. Roll back by redeploying the prior approved API
revision; the new routes/protections become unavailable but existing data stays unchanged.
Do not reverse shared migrations or delete orders to roll back this code.

Deploy the cart repository and checkout locking changes together. Drain/stop
private staging API instances before replacing them: an old checkout writer does
not participate in the new per-customer cart lock. See the
[cart increment report](POSTGRES_CART_INCREMENT_2026-11-04.md) for contracts and
concurrency evidence. Rolling back loses those endpoints/protections, not data.

Also deploy coupon validation and checkout wiring together. Drain old API writers
that silently ignored coupon codes before staging coupon tests. Keep recorded
order discounts and coupon usage counters intact during rollback; do not reset
them. Disable coupon test traffic before reverting to code without validation.
See the [coupon increment report](POSTGRES_COUPON_INCREMENT_2026-11-04.md) for
expiry semantics, server-cart preview and unresolved funding/settlement rules.

Main still fails closed for HTTP checkout when shipping policy is missing.
Open PR #91 addresses policy injection and must be reviewed separately. Customer
tracking exposes existing stored shipments (with sandbox mode), not a live
courier integration. Never bypass the production startup guard to work around
these gaps.

## 4. Before production
- Complete and verify remaining PostgreSQL route/adapter parity, HTTP checkout and reviewed migrations.
- Use secure session lifecycle, password reset and OTP verification.
- Configure TLS, strict CORS, CSRF protections where applicable, rate limits and security headers.
- Store secrets in the host secret manager; never commit `.env`.
- Configure database backups, restore drills, monitoring and alerting.
- Integrate payment and courier providers in sandbox first; validate signatures and idempotency.
- Complete security, privacy, tax, consumer-protection and operational reviews.
- Remove development seed accounts and demo credentials.

This repository remains a development MVP and is not production-ready.

## Historical Neon PostgreSQL provisioning notes (2026-11-01)

The following are historical project notes, not live infrastructure verification by this session. The current explicit PostgreSQL development entrypoint supersedes the old claim that every API path uses SQLite. The production gate still applies.
- Neon project `haat-bangladesh` is provisioned (PostgreSQL 17, Singapore region), database `haat`.
- PostgreSQL migrations `001_init.sql` and `002_indexes.sql` have been applied to the Neon main branch. Verification confirmed 24 application tables and 45 indexes.
- A separate `haat-schema-validation` branch was also created for schema validation.
- This is database schema provisioning only. The API still uses the synchronous `node:sqlite` interface. Do not deploy the API as production until the PostgreSQL runtime adapter, async route conversion, seed compatibility, and end-to-end tests are complete.
