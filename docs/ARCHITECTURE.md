# Architecture

## Current MVP runtime
- Web: Node HTTP static server on port 3000.
- API: Node.js HTTP service on port 4000.
- Development persistence: SQLite database file under `data/`.
- Browser storefront calls the API under `/api/v1`.
- API money values are stored in integer paisa and exposed as BDT display values.

## Intended production architecture
- PostgreSQL as the source of truth.
- Stateless API instances behind a reverse proxy / load balancer.
- Object storage + CDN for product media.
- Payment adapter layer for licensed Bangladesh payment providers.
- Courier adapter layer with webhook signature validation and reconciliation.
- Queue workers for notifications, order events and payout processing.
- Centralized logs, metrics, tracing, alerting and encrypted backups.

## Trust boundaries
Client-side validation is only for usability. All authorization, stock checks, pricing, seller ownership and payment state transitions must be enforced server-side. Treat payment and courier webhooks as untrusted until signatures and idempotency keys are verified.
