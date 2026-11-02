# HAAT — Bangladesh Multi-Vendor Marketplace

বাংলাদেশের জন্য বাংলা-প্রথম multi-vendor e-commerce platform-এর development repository। BDT pricing, customer storefront, seller/admin workspace এবং COD checkout লক্ষ্য করে তৈরি।

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
- PostgreSQL repositories for catalog, authentication, customer addresses/wishlist/reviews, inventory, checkout and order/payment domains
- PostgreSQL connection-pool factory and an advisory-lock migration bootstrap command

## Still required before production
- PostgreSQL implementations for remaining seller product/finance and admin management/finance routes
- PostgreSQL API composition that does not import or execute SQLite-backed routes or seed data
- Real Neon/PostgreSQL integration tests and full browser E2E coverage
- Public Node.js API hosting, persistent production database, secrets and monitoring
- Live payment/courier credentials and provider webhook verification
- Full security, privacy and operational review
- Native Android/iOS application

## Requirements
- Node.js 22.5+
- npm

## Run locally
```bash
cp .env.example .env
npm install
npm run dev
```
- Customer storefront: http://localhost:3000
- Seller placeholder: http://localhost:3000/seller.html
- Admin placeholder: http://localhost:3000/admin.html
- API health: http://localhost:4000/health

## PostgreSQL migration bootstrap (staging/development only)

Install dependencies, set `DATABASE_URL` and the PostgreSQL TLS/pool variables from `.env.example`, then run:

```bash
npm run db:migrate:postgres
```

The command verifies the database connection, applies ordered SQL files from `apps/api/migrations/postgres`, and uses a PostgreSQL advisory lock so concurrent deploy jobs do not apply the same migration simultaneously. It prints migration names but never prints the connection URL or password.

**Important:** this command only prepares/checks the PostgreSQL schema. It does not switch the API to PostgreSQL. Production API startup remains blocked intentionally because some customer, seller and admin routes still use SQLite. Do not point a live API at a PostgreSQL database until that remaining route migration and end-to-end validation are complete.

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

GitHub Pages is static hosting, so these portal pages cannot reach the API there yet. The storefront now intentionally hides the old hard-coded sample products when the API is offline and displays a clear connection status; it will show only products returned by the live API. Run the web and API services together (or deploy the API and web server to a supported host) to exercise login, seller submission, moderation and COD checkout. Never use the demo credentials in a production deployment.
