# PostgreSQL runtime adapter — developer notes

The adapter in `apps/api/src/postgres-runtime.mjs` is an isolated, testable foundation. It is **not wired into `core.mjs` or the HTTP server**, and must not be treated as a production-ready database runtime.

## Contract

```js
import pg from 'pg';
import { createPostgresDatabase } from './postgres-runtime.mjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { q, tx } = createPostgresDatabase(pool);

const product = await q('SELECT id FROM products WHERE id=?').get(productId);
const rows = await q('SELECT id FROM products WHERE active=?').all(true);
const result = await q('UPDATE products SET active=? WHERE id=?').run(false, productId);

await tx(async () => {
  await q('UPDATE inventory SET stock=stock-? WHERE product_id=?').run(1, productId);
});
```

All methods are asynchronous. Every caller must use `await`; do not attempt to preserve the old synchronous `node:sqlite` API.

## Transaction guarantees

- Top-level transaction checks out one Pool client, starts `BEGIN`, routes all async-context queries to that client, then commits or rolls back.
- Nested `tx` calls use uniquely named savepoints.
- Client release occurs in `finally`, including failed transactions.
- Concurrent async transactions are isolated using `AsyncLocalStorage`.
- A failed savepoint rolls back to that savepoint and can be caught by the outer transaction.

## Important constraints

- This module expects a pg-compatible Pool supplied by its caller; it does not import `pg` or create a connection.
- `run()` returns `changes` from PostgreSQL `rowCount`. Insert identifiers are available only when SQL explicitly includes `RETURNING id`.
- The placeholder translator handles positional `?` parameters outside SQL strings, quoted identifiers, comments and dollar-quoted bodies. PostgreSQL operators that contain question marks (for example JSONB `?`, `?|`, `?&`) must be reviewed/escaped or expressed using named SQL alternatives before migration.
- Do not share a transaction context with detached/background promises that outlive the transaction callback.
- Configure pool limits, TLS, connection timeouts, shutdown handling and numeric type parsing at the application bootstrap layer.
- Existing application modules are synchronous and are not compatible until all query/transaction callsites are converted to async/await.
- Production startup guard remains mandatory until the complete API passes PostgreSQL integration and concurrency tests.

## Tests

`tests/postgres-runtime.test.mjs` uses a fake Pool to validate query parameterization, async result contracts, transaction pinning, rollback, nested savepoints, and concurrent transaction isolation without requiring a live database.

## PostgreSQL migration runner

`apps/api/src/postgres-migrations.mjs` adds an explicit migration runner for a supplied pg-compatible Pool. It acquires a PostgreSQL session advisory lock, applies numbered SQL files in lexical order, records each successful migration in `schema_migrations`, skips recorded files, and rolls back a failed migration. The runner is intentionally not called by the current SQLite server; wiring it in requires the future PostgreSQL bootstrap and connection lifecycle.

The runner uses one checked-out client for the lock and all migration transactions. Do not run schema migrations through a transaction-pooled proxy that cannot preserve session-level advisory locks.

## Neon ledger compatibility check

The configured Neon `haat` main branch was inspected read-only after adding the runner. Its existing `schema_migrations.applied_at` column is `TEXT NOT NULL` (with a `now()::text` default), not `TIMESTAMPTZ`. The runner therefore explicitly supplies an ISO timestamp when inserting the ledger row; this works with the already-provisioned schema and with the runner's own `TIMESTAMPTZ` table definition. The main branch currently records `001_init.sql`, `002_indexes.sql`, and `003_seed_categories.sql`. No Neon data or schema was modified during this check.

## BIGINT numeric parsing

PostgreSQL `BIGINT` values are commonly returned as strings by node-postgres. The optional helper in `apps/api/src/postgres-types.mjs` registers a parser for OID 20 and converts values to JavaScript numbers only when they fit `Number.MAX_SAFE_INTEGER`. This matters because marketplace prices, balances, stock counts and SQL `COUNT(*)` values are consumed by application arithmetic. Values outside the safe range fail loudly instead of silently rounding. Configure the parser before constructing the Pool; do not apply it to arbitrary `NUMERIC`/decimal values.
