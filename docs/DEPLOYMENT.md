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
3. For an isolated private development demo only, attach persistent storage and set `SQLITE_FILE` to a writable path. Never use ephemeral storage for data you need to keep.
4. Keep `NODE_ENV=development` for the current SQLite demo runtime and protect it behind private access; demo accounts are seeded in this mode.
5. Do not set `NODE_ENV=production`: the API intentionally exits with a clear error until the PostgreSQL runtime adapter and production migration path exist.
6. `DATABASE_URL` is currently reserved/documentary and is not consumed by the application.
7. After a supported database runtime is implemented, configure exact HTTPS `CORS_ORIGINS`, secret-manager values, admin bootstrap and health checks.
8. Set `window.HAAT_API_BASE` to the API origin only after the API is deployed and validated; redeploy the frontend and run staging E2E tests.

**Important:** GitHub Pages is a static preview. The current API uses SQLite, and the application deliberately blocks production mode rather than risk accepting real customer/payment data without a supported persistent production database.

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

## Neon PostgreSQL provisioning status (2026-11-01)
- Neon project `haat-bangladesh` is provisioned (PostgreSQL 17, Singapore region), database `haat`.
- PostgreSQL migrations `001_init.sql` and `002_indexes.sql` have been applied to the Neon main branch. Verification confirmed 24 application tables and 45 indexes.
- A separate `haat-schema-validation` branch was also created for schema validation.
- This is database schema provisioning only. The API still uses the synchronous `node:sqlite` interface. Do not deploy the API as production until the PostgreSQL runtime adapter, async route conversion, seed compatibility, and end-to-end tests are complete.
