# HAAT — Bangladesh Multi-Vendor Marketplace

বাংলাদেশের জন্য বাংলা-প্রথম multi-vendor e-commerce platform-এর development repository। BDT pricing, customer storefront, seller/admin workspace এবং COD checkout লক্ষ্য করে তৈরি।

## Current GitHub branch status
**Initial development scaffold — not the complete marketplace MVP and not production-ready.**

### Implemented in this branch
- Bengali-first customer storefront with product/category listing and client-side search
- Development seed accounts and phone/password login
- SQLite-backed category and product catalogue
- COD order creation with stock validation and deduction
- Web server proxies `/api/*` requests to the API service
- Prisma PostgreSQL target schema, OpenAPI starter contract, Docker and CI scaffolding

### Not implemented yet
- Real seller registration, seller product submission and seller order management
- Admin moderation, finance, refund and payout workflows
- Multi-seller order splitting and seller commission settlement
- Customer address book, order history, notifications and returns
- Live bKash/Nagad/card gateway or courier integration
- Production PostgreSQL adapter and migration execution
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
- `prisma` — initial PostgreSQL target schema
- `docs` — architecture, status and deployment notes
- `infra/docker` — container scaffolding
- `tests` — API smoke test

## Production warning
Do not process real customer data or payments with this scaffold. See [docs/STATUS_BN.md](docs/STATUS_BN.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [SECURITY.md](SECURITY.md).
