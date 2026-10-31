# Deployment guide

## Local development
```bash
cp .env.example .env
npm install
npm run dev
```

## Before staging / production
- Replace the SQLite development adapter with PostgreSQL and apply reviewed migrations.
- Configure TLS, secure session handling, CSRF protections where applicable, rate limits and trusted CORS origins.
- Set secrets through the hosting provider's secret manager; never commit `.env`.
- Configure database backups, restore drills, monitoring and alerting.
- Integrate payment and courier providers in sandbox first; validate signatures and idempotency.
- Complete security, privacy, tax, consumer-protection and operational reviews.
- Remove development seed accounts and demo credentials.

This repository is a development MVP. Do not expose it to real customers or process real payments yet.
