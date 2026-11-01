# PostgreSQL Authentication & Session Security Audit

## Overview
This document outlines the security architecture, session lifecycle, OTP verification rules, multi-vendor authorization guarantees, and production safeguards implemented and hardened for the Bangladesh Multi-Vendor Marketplace under Issue #7.

## 1. Authentication Architecture & Adapter Pattern
- Authentication and session storage is implemented as an async repository pattern in `apps/api/src/postgres-auth.mjs`.
- Instantiation is handled via `createPostgresAuthRepository(database, overrides)` accepting a PostgreSQL database adapter exposing `.q(sql)` and `.tx(callback)`.
- Full backward compatibility with the existing local SQLite runtime is maintained:
  - In local development / SQLite mode, `createSqliteAuthRepository()` is used.
  - When `postgresDatabase` is provided in `createApiApp({ postgresDatabase })`, `createPostgresAuthRepository` is wired in.
  - Public routes (`/api/v1/auth/*`) delegate to the injected repository.

## 2. OTP Security Rules & Concurrency Hardening
- **Expiration**: OTP codes expire after 15 minutes (`expires_at < now`).
- **Single-Use Consumption**: Once verified, the OTP is stamped with `used_at = now`. An already used OTP (`used_at IS NOT NULL`) cannot be verified again.
- **Maximum 5 Verification Attempts**: Each failed submission atomically increments the attempt counter. At 5 or more failed attempts, the code is locked and cannot be used.
- **Atomic Concurrency Protection**: Verification is executed inside a transaction using row-level locking (`SELECT ... FOR UPDATE` on `otp_codes`). Concurrent verification requests serialize on the row lock; exactly one can consume the code while simultaneous or replay requests fail.
- **Failed Attempt Persistence**: Failed attempts commit to the database even if the caller receives an error, preventing attackers from rolling back failed attempts.

## 3. Session Management Lifecycle
- **Session Creation**: Generates 32 bytes of cryptographically secure random bytes via `crypto.randomBytes(32)` represented as a 64-character hex string.
- **Token Hashing**: Tokens are stored as SHA-256 hashes (`token_hash`) in the `sessions` table. Cleartext tokens are never stored in the database.
- **Expiration & Validation**: Sessions expire according to `config.sessionDays` (default 30 days). Expired sessions are rejected and periodically pruned via `cleanupExpiredSessions()`.
- **Revocation**:
  - `POST /api/v1/auth/logout`: Revokes the active session token hash.
  - `POST /api/v1/auth/change-password`: Revokes all other sessions for the user (`token_hash <> current_token_hash`).
  - `POST /api/v1/auth/reset-password`: Revokes all sessions for the user upon password reset.

## 4. Multi-Vendor Authorization & Privilege Escalation Prevention
- **Customer Registration**: Payload `role` or privilege fields are ignored. The account role is strictly set to `CUSTOMER`.
- **Seller Registration**: Payload `role` and `status` fields are ignored. The account role is strictly set to `SELLER` and the seller profile status is set to `PENDING`.
- **Portal Gating**: `login` validates the optional `portal` parameter against `user.role` (e.g. customers cannot log into the seller portal).
- **Suspended Accounts**: Inactive and suspended users (`status <> 'ACTIVE'`) are blocked at login and session resolution.
- **Profile Updates**: `PATCH /api/v1/me` only permits updating name, phone, and email; user `role` and `status` cannot be altered.

## 5. Production Safety Guard
- In production mode (`NODE_ENV=production`), the application enforces that the PostgreSQL adapter is connected and fails closed if configuration is missing.
- Sensitive values (passwords, OTP plaintexts, session tokens, secrets) are never exposed in error responses or logs.

## 6. Automated Security Regression Testing
Automated tests covering all required scenarios:
- `tests/postgres-auth.test.mjs`: Core repository operations, registration, login, duplicate checks, password change, and OTP reset.
- `tests/postgres-auth-concurrency.test.mjs`: Concurrent valid OTP requests (exactly one succeeds), concurrent wrong codes locking at 5 attempts, expired OTP rejection, replay attack rejection.
- `tests/postgres-auth-routes.test.mjs`: Route integration via HTTP with PostgreSQL auth repository.
- `tests/postgres-auth-security-audit.test.mjs`: Role escalation prevention, profile parameter tampering, and cross-account session isolation.

Run tests:
```bash
npm test
npm run check
```
