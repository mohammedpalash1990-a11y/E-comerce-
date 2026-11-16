# Musafir Fast Food POS

A premium responsive restaurant operations demo built with React, TypeScript, Vite, Tailwind CSS and PostgreSQL API scaffolding.

## Start the PostgreSQL database and API

Requirements: Node.js 20+, Docker Compose, and a private deployment environment.

```sh
cp .env.example .env
# Change JWT_SECRET and SEED_ADMIN_PASSWORD before starting anything.
# Set POSTGRES_PASSWORD to the same secure value as the password portion of DATABASE_URL.
docker compose up -d db
npm install
npm run db:migrate
npm run db:seed
npm run api:dev
```

In another terminal run `npm run dev`. Vite proxies `/api` requests to `http://localhost:3001`. Health check: `http://localhost:3001/api/health`.

Seed admin credentials come from `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`. Never commit `.env`; disable/delete the seeded account and provision real users before exposing this service. JWT signing key must be at least 32 characters. Use HTTPS, a strong database password, backups, and a secret manager in deployment.

## Backend endpoints delivered

- `POST /api/auth/login`, `GET /api/auth/me`: bcrypt password verification, short-lived JWT, active-user reload, login rate limiting.
- `GET /api/inventory`, `POST/PATCH /api/inventory`: role-checked ingredient listing/editing.
- `POST /api/purchases`: transactional supplier invoice, stock receiving, stock movement and initial payment.
- `GET /api/suppliers`, `POST /api/suppliers/:id/payments`, `GET /api/payables`: supplier balances/payments.
- `POST /api/orders`: transactional order insertion and recipe stock deduction with stock row locks and negative-stock rejection.
- `GET /api/menu`, `GET /api/menu/qr`: public menu and generated PNG QR code (requires a public hosted menu URL and branch id).
- `GET /api/health`: database connectivity.

PostgreSQL schema supports organizations, branches, roles, users, products, categories, ingredient stock, recipes, customers, orders, payments, suppliers, purchases, stock movements and audit logs. The API scopes operational data by authenticated organization/branch and roles. Financial changes are transactionally recorded.

## Frontend status and limitations

The existing mobile-responsive admin UI and local demo workflows remain. The API is an initial backend foundation and is not yet fully connected to the React views: login UI/token lifecycle, inventory edit forms, purchase/payment UI, remote menu/order fetching, and database-to-dashboard reporting still need integration. The generated QR endpoint returns an actual PNG but needs deployment URL configuration; the customer ordering page itself is not yet built. No live payment gateway is configured. This is not yet production-ready: run typechecks, integration/security tests, create migrations/backups policy, and review the API before handling real financial data.

## Useful commands

```sh
npm run build
npm run typecheck:server
npm run db:migrate
npm run db:seed
npm run api:dev
```

## Employees, attendance and payroll

Employees, daily attendance, salary advances, payroll (bonus and deductions) and salary payments are stored in PostgreSQL (`db/migrations/002_team_payroll.sql` and `003_payroll_hardening.sql`) and served by `server/hr.ts`. Everything is scoped to the signed-in user's organization and branch, amounts are SAR, and salary payments are Cash or Mada only.

| Area | Owner / Manager | Accountant | Other roles |
| --- | --- | --- | --- |
| Employees: view | yes | yes | no |
| Employees: add, edit, deactivate | yes | no | no |
| Attendance: view and mark | yes | no | no |
| Salary advance, create payroll | yes | no | no |
| Payroll: view | yes | yes | no |
| Salary payment (partial or full) | yes | yes | no |

- One attendance record per employee per day (`Present`, `Absent`, `On Leave`); marking again updates it.
- Net salary = base + bonus - advance deduction - other deduction. Status is calculated on the server: `Unpaid`, `Part-paid` or `Paid`. A payment can never exceed the remaining salary, even when two are sent at the same time.
- Every salary payment is its own row (history is kept) and is written in the same database transaction as its audit log entry.
- Deactivating an employee keeps their attendance and payroll history.

Tests: `npm test` runs the unit and contract tests. `npm run test:integration` runs the end-to-end API tests and needs a running API plus a **throwaway** PostgreSQL database (`DATABASE_URL`); CI starts both automatically.
