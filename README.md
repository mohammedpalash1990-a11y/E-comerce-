# HAAT — Bangladesh Multi-Vendor Marketplace

বাংলাদেশের জন্য বাংলা-প্রথম multi-vendor e-commerce platform-এর development repository। BDT pricing, customer storefront, seller/admin workspace এবং COD checkout লক্ষ্য করে তৈরি।

## Verified development update — 2026-11-04

See [the current implementation report](docs/DEVELOPMENT_REPORT_2026-11-04.md) for the repository audit, team handoff, exact test evidence and remaining work. The explicit PostgreSQL development API now includes customer order detail/tracking, saved-cart routes and method-aware dispatch for seller product writes. See the [cart increment report](docs/POSTGRES_CART_INCREMENT_2026-11-04.md) for its contract and concurrency tests. The [coupon increment report](docs/POSTGRES_COUPON_INCREMENT_2026-11-04.md) covers server-cart-based coupon preview and transactional redemption. The [admin coupon increment](docs/POSTGRES_ADMIN_COUPON_INCREMENT_2026-11-04.md) adds validated creation, bounded listing and audited activation controls. Both production startup guards remain enabled.

**Design baseline:** root `index.html` is the canonical static HAAT demo used by browser tests. The Node web server and Pages workflow currently serve the different `apps/web/public/index.html`. Reconcile these through frontend review; do not overwrite either blindly. Native apps and complete live browser checkout are not delivered.

## Current GitHub branch status
**Active MVP development — public storefront preview is deployed; the API is not yet publicly hosted and the live catalog/order flows are unavailable on GitHub Pages. Not production-ready.**

### Implemented in this branch
- Bengali-first customer storefront with product/category listing and client-side search
- Development seed accounts and phone/password login
- SQLite-backed category and product catalogue
- COD checkout API with delivery address capture, stock validation, transactional deduction, persisted order line items and customer order-history API
- Admin order queue with delivery details and controlled order-status transitions; eligible cancellations restore stock
- Web server proxies `/api/*` requests to the API service
- Storefront loads only API-backed products; if the API is offline it clearly reports preview/offline status instead of silently showing hard-coded sample products
- Seller and admin pages show whether the API and database health endpoint is reachable
- Seller product submission supports descriptions and HTTPS image URLs; seller and admin views can preview uploaded product images
- Admin console includes live KPI cards and pending seller application approvals
- Storefront has a manual API retry control; customer cart persists under a versioned local-storage key
- Storefront automatically uses live catalogue and COD checkout when served alongside the API; GitHub Pages remains a static preview
- Prisma PostgreSQL target schema, OpenAPI starter contract, Docker and CI scaffolding

### Implemented in the modular development API
- Seller product submission, product listing and seller-specific order fulfilment
- Admin product moderation, seller/customer management, order status, refunds and payout workflow endpoints
- Multi-vendor checkout with seller sub-orders and commission ledger entries
- Customer order history, address and account endpoints, notifications
- Sandbox payment and courier adapters only

## Still required before production
- Complete remaining route parity in the existing isolated PostgreSQL API; keep its SQLite-free composition and production gate
- Live PostgreSQL migration and checkout/order/payment/inventory integration verification
- Public Node.js API hosting, persistent production database, secrets and monitoring
- Live payment/courier credentials and provider webhook verification
- Full browser E2E, security, privacy and operational review
- Native Android/iOS application

## Requirements
- Node.js 22.5+
- npm

## Run locally
```bash
cp .env.example .env
npm ci
npm run dev
```
- Customer storefront: http://localhost:3000
- Seller workspace: http://localhost:3000/seller.html
- Admin workspace: http://localhost:3000/admin.html
- API health: http://localhost:4000/health

## PostgreSQL migration bootstrap (staging/development only)

Set `DATABASE_URL` and the PostgreSQL TLS/pool variables from `.env.example`, then run:

```bash
npm run db:migrate:postgres
```

This command verifies the PostgreSQL connection and applies ordered SQL files from `apps/api/migrations/postgres` under the database advisory lock. It does not start the API in PostgreSQL mode. Production API startup remains deliberately blocked until PostgreSQL-only route composition and end-to-end validation are complete. Do not point a live API at a PostgreSQL database yet.

## Development demo accounts
| Role | Phone | Password |
|---|---|---|
| Customer | 01700000003 | Customer@12345 |
| Seller | 01700000002 | Seller@12345 |
| Admin | 01700000001 | Admin@12345 |

These accounts are local development seed data only. Change all credentials and secrets before deployment.

## Checks
```bash
npm test
npm run check
```

## Bangladesh defaults
- Currency display: BDT; persisted amounts use integer paisa
- Primary language: Bengali
- Checkout: COD development flow only

## Repository map
- `apps/web` — customer storefront and seller/admin placeholder pages
- `apps/api` — Node.js API + local SQLite development adapter
- `apps/api/migrations/postgres` — PostgreSQL target schema migrations
- `prisma` — initial PostgreSQL target schema
- `docs` — architecture, status and deployment notes
- `infra/docker` — container scaffolding
- `tests` — API and adapter tests

## Production warning
Do not process real customer data or payments with this scaffold. See [docs/STATUS_BN.md](docs/STATUS_BN.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [SECURITY.md](SECURITY.md).

## Preview and demo access

- Storefront: https://mohammedpalash1990-a11y.github.io/E-comerce-/
- Seller workspace: https://mohammedpalash1990-a11y.github.io/E-comerce-/seller.html
- Admin workspace: https://mohammedpalash1990-a11y.github.io/E-comerce-/admin.html

Demo credentials (development only):
- Customer: `01700000003` / `Customer@12345`
- Seller: `01700000002` / `Seller@12345`
- Admin: `01700000001` / `Admin@12345`

GitHub Pages is static hosting, so these portal pages cannot reach the API there yet. Never use demo credentials in a production deployment.
