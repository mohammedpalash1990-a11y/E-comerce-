# Deployment guide

## 1. Local development
Requirements: Node.js 22.5+ and npm.

```bash
cp .env.example .env
npm install
npm run dev
```

The development launcher serves the storefront and API locally. The SQLite database is for development only.

## 2. GitHub Pages preview
GitHub Pages hosts only static files. It does not execute the Node.js API, SQLite database, sessions, or payment/courier adapters. Customer login, seller actions, admin actions and checkout will not work on Pages alone.

## 3. Deploying the API to a Node.js host
1. Deploy the repository to a Node.js 22.5+ service (not a static-site service).
2. Set the start command to `npm run start:api`.
3. Attach persistent storage and set `SQLITE_FILE` to a writable persistent path for a private staging/demo only. Do not use SQLite on ephemeral storage.
4. Set `NODE_ENV=production`, `PORT` from the host, `CORS_ORIGINS` to the exact HTTPS storefront origin(s), and a strong unique `PAYMENT_WEBHOOK_SECRET`.
5. Configure `ADMIN_PHONE` and `ADMIN_PASSWORD` only for first production admin bootstrap. Never use the demo credentials.
6. Verify `GET /health` and review server logs before connecting the frontend.
7. Set `window.HAAT_API_BASE` in `apps/web/public/api-config.js` to the API origin only (for example `https://api.example.com`, without `/api/v1`).
8. Redeploy the static frontend and test customer, seller and admin flows against the staging API.

**Important:** the current runtime is SQLite-backed. A PostgreSQL URL in `.env.example` does not mean the API is already using PostgreSQL. Do not use this configuration for real customer or payment data.

## 4. Before production
- Implement and test the PostgreSQL runtime adapter and reviewed migrations.
- Use secure session lifecycle, password reset and OTP verification.
- Configure TLS, strict CORS, CSRF protections where applicable, rate limits and security headers.
- Store secrets in the host secret manager; never commit `.env`.
- Configure database backups, restore drills, monitoring and alerting.
- Integrate payment and courier providers in sandbox first; validate signatures and idempotency.
- Complete security, privacy, tax, consumer-protection and operational reviews.
- Remove development seed accounts and demo credentials.

This repository remains a development MVP and is not production-ready.
