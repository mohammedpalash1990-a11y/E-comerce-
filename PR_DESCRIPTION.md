# Employees, Attendance and Payroll: finish backend integration

Base: `build/premium-pos-phase-1`

## What changed
- **Bug fix:** the HR validators and the `payroll_records.period` CHECK in `002_team_payroll.sql` used a doubly escaped `\\d`, so no real date or month could pass (attendance, payroll and payment requests were always rejected). New migration `003_payroll_hardening.sql` drops the broken CHECK and adds a working one; the API validators are fixed.
- HR routes moved from `server/index.ts` into `server/hr.ts` (authenticated, role-checked, organization + branch scoped, validated with zod, transactions, audit log in the same transaction).
- Employees: add, edit, **deactivate / reactivate** (history is kept). Attendance: list by date, one record per employee per day. Payroll: bonus, advance deduction and a new manual **deduction**; `Unpaid` / `Part-paid` / `Paid` calculated on the server in integer halalas; every payment is its own row (Cash or Mada, SAR) and can never exceed the remaining salary (row lock).
- Permissions: Owner/Manager everything; Accountant views payroll and records payments only; other roles have no access. (Previously Accountant could also create payroll.)
- Frontend: Employees, Attendance and Payroll screens use the API (date picker for attendance, Deactivate button, deduction prompt, role-aware buttons, restricted message for other roles). Connected mode no longer keeps payroll/employee data in browser storage. Existing layout and styling are unchanged.
- This branch has no `/api/sync` or `/api/bootstrap`; a test asserts they do not exist.
- Tests: `npm test` (unit + contract), `npm run test:integration` (real PostgreSQL, run in CI). `ci.yml` now starts PostgreSQL, builds, runs both suites.

## Not touched
POS orders, inventory, purchases, supplier payments, expenses, the `payments` table, the database engine (still PostgreSQL/Neon), currency, UI design.

## Before merging
- [ ] CI green on this PR (build, unit tests, integration tests)
- [ ] Run `npm run build` locally
- [ ] Note: `.github/workflows/ci.yml` and `server/migrate.ts` are also touched by PR #2; expect a small conflict to resolve in whichever merges second.
