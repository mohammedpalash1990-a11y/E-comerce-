# HAAT — Bangladesh Multi-Vendor Marketplace

বাংলাদেশের জন্য বাংলা-প্রথম multi-vendor e-commerce platform। BDT pricing, customer storefront, seller workspace, admin moderation এবং Cash on Delivery (COD) checkout-কে কেন্দ্র করে MVP তৈরি।

## Project status
**MVP / development preview — not production-ready.** The current API adapter uses local SQLite for development. Production deployment is intentionally blocked until PostgreSQL migrations, payment/courier integrations, secrets, monitoring and security review are completed.

## Included capabilities
- Bengali-first customer storefront with product discovery, category filters and cart
- Customer registration/login and order history
- Seller portal for product submission and order operations
- Admin dashboard for seller/product moderation and audit visibility
- COD checkout, order splitting by seller, commission calculation and stock deduction
- OpenAPI contract, Prisma PostgreSQL target schema, Docker scaffolding and CI tests

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
- Seller portal: http://localhost:3000/seller.html
- Admin console: http://localhost:3000/admin.html
- API health: http://localhost:4000/health

## Demo accounts
| Role | Phone | Password |
|---|---|---|
| Customer | 01700000003 | Customer@12345 |
| Seller | 01700000002 | Seller@12345 |
| Admin | 01700000001 | Admin@12345 |

Change all demo credentials and secrets before any shared deployment. Seed accounts are development-only.

## Quality checks
```bash
npm test
npm run check
```

## Bangladesh defaults
- Currency: BDT (integer paisa storage)
- Primary language: Bengali; English product fields supported
- Checkout: COD only in the current MVP
- Default shipping fee and commission are demo configuration, not final commercial policy

## Repository map
- `apps/web` — customer storefront and seller/admin pages
- `apps/api` — API service
- `apps/mobile` — mobile app planning scaffold
- `prisma` — PostgreSQL target data model
- `docs` — architecture, workflows, security and release plan
- `infra/docker` — local container scaffolding
- `tests` — API integration tests

## Production blockers
See [docs/STATUS_BN.md](docs/STATUS_BN.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [SECURITY.md](SECURITY.md). Do not deploy this MVP with real customer data until those blockers are closed.
