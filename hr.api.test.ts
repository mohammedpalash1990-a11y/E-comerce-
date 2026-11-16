// End-to-end tests for Employee / Attendance / Payroll against a real PostgreSQL database and the running API.
// Run in CI (see .github/workflows/ci.yml) or locally against a THROWAWAY database:
//   npm run db:migrate && npm run api:dev   (in another terminal)   then   npm run test:integration
// The suite creates its own organizations, branches and users, so it needs no seed data. It signs in six users, which
// stays inside the login rate limit (10 per 15 minutes per IP) once per run.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

const API = (process.env.API_URL || 'http://localhost:3001').replace(/\/$/, '');
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const suffix = randomUUID().slice(0, 8);
const PASSWORD = 'Integration-Test-Pass-1';

type Reply = { status: number; body: any };
async function call(method: string, path: string, token?: string, body?: unknown): Promise<Reply> {
  const response = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed: any = null;
  try { parsed = await response.json(); } catch { /* empty body */ }
  return { status: response.status, body: parsed };
}

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const num = (value: unknown) => Number(value);

async function createUser(key: string, organizationId: string, branchId: string, role: string) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const email = `${key}-${suffix}@it.local`;
  await db.query('INSERT INTO users(organization_id, branch_id, email, password_hash, display_name, role) VALUES($1, $2, $3, $4, $5, $6)', [organizationId, branchId, email, hash, key, role]);
  const login = await call('POST', '/api/auth/login', undefined, { email, password: PASSWORD });
  assert.equal(login.status, 200, 'login ' + key);
  tokens[key] = login.body.token;
}

before(async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const health = await fetch(API + '/api/health'); if (health.ok) break; } catch { /* API still starting */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (attempt === 39) throw new Error('API did not become healthy at ' + API);
  }
  const orgA = (await db.query('INSERT INTO organizations(name, slug) VALUES($1, $2) RETURNING id', ['IT Org A ' + suffix, 'it-a-' + suffix])).rows[0].id;
  const orgB = (await db.query('INSERT INTO organizations(name, slug) VALUES($1, $2) RETURNING id', ['IT Org B ' + suffix, 'it-b-' + suffix])).rows[0].id;
  const a1 = (await db.query('INSERT INTO branches(organization_id, name, code) VALUES($1, $2, $3) RETURNING id', [orgA, 'Main', 'A1'])).rows[0].id;
  const a2 = (await db.query('INSERT INTO branches(organization_id, name, code) VALUES($1, $2, $3) RETURNING id', [orgA, 'Second', 'A2'])).rows[0].id;
  const b1 = (await db.query('INSERT INTO branches(organization_id, name, code) VALUES($1, $2, $3) RETURNING id', [orgB, 'Main', 'B1'])).rows[0].id;
  ids.orgA = orgA;
  await createUser('ownerA', orgA, a1, 'owner');
  await createUser('managerA', orgA, a1, 'manager');
  await createUser('accountantA', orgA, a1, 'accountant');
  await createUser('cashierA', orgA, a1, 'cashier');
  await createUser('managerA2', orgA, a2, 'manager');
  await createUser('ownerB', orgB, b1, 'owner');
});

after(async () => { await db.end(); });

test('unauthenticated requests are rejected and no sync/bootstrap endpoint exists', async () => {
  assert.equal((await call('GET', '/api/employees')).status, 401);
  assert.equal((await call('GET', '/api/payroll')).status, 401);
  assert.equal((await call('GET', '/api/attendance')).status, 401);
  assert.equal((await call('POST', `/api/payroll/${randomUUID()}/payments`, undefined, { amount: 1, method: 'Cash' })).status, 401);
  assert.equal((await call('GET', '/api/bootstrap')).status, 404);
  assert.equal((await call('POST', '/api/sync', undefined, {})).status, 404);
});

test('roles without HR access cannot see employees, attendance or payroll', async () => {
  assert.equal((await call('GET', '/api/employees', tokens.cashierA)).status, 403);
  assert.equal((await call('GET', '/api/payroll', tokens.cashierA)).status, 403);
  assert.equal((await call('GET', '/api/attendance', tokens.cashierA)).status, 403);
  assert.equal((await call('POST', `/api/payroll/${randomUUID()}/payments`, tokens.cashierA, { amount: 1, method: 'Cash' })).status, 403);
});

test('employees: add, edit and validate; accountant is read-only', async () => {
  const created = await call('POST', '/api/employees', tokens.managerA, { name: 'Ali', role: 'Cook', shift: 'Morning', salary: 3000 });
  assert.equal(created.status, 201);
  ids.ali = created.body.employee.id;
  const second = await call('POST', '/api/employees', tokens.ownerA, { name: 'Sara', role: 'Cashier', shift: 'Evening', salary: 1000 });
  assert.equal(second.status, 201);
  ids.sara = second.body.employee.id;
  assert.equal((await call('POST', '/api/employees', tokens.managerA, { name: 'Bad', salary: -5 })).status, 400);
  assert.equal((await call('POST', '/api/employees', tokens.managerA, { name: 'Bad', salary: 10.005 })).status, 400);
  assert.equal((await call('POST', '/api/employees', tokens.accountantA, { name: 'Nope', salary: 100 })).status, 403);
  const list = await call('GET', '/api/employees', tokens.accountantA);
  assert.equal(list.status, 200);
  const ali = list.body.employees.find((row: any) => row.id === ids.ali);
  assert.equal(ali.status, 'Not marked');
  assert.equal(num(ali.salary), 3000);
  const edited = await call('PATCH', `/api/employees/${ids.ali}`, tokens.managerA, { shift: 'Evening' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.employee.shift, 'Evening');
  assert.equal((await call('PATCH', `/api/employees/${ids.ali}`, tokens.managerA, {})).status, 400);
  assert.equal((await call('PATCH', `/api/employees/${ids.ali}`, tokens.accountantA, { shift: 'Night' })).status, 403);
});

test('attendance: one record per employee per day, validated, manager only', async () => {
  const first = await call('POST', '/api/attendance', tokens.managerA, { employeeId: ids.ali, date: '2026-01-15', status: 'Present' });
  assert.equal(first.status, 200);
  const changed = await call('POST', '/api/attendance', tokens.managerA, { employeeId: ids.ali, date: '2026-01-15', status: 'Absent' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.attendance.status, 'Absent');
  const count = await db.query("SELECT count(*)::int AS total FROM employee_attendance WHERE employee_id = $1 AND attendance_date = '2026-01-15'", [ids.ali]);
  assert.equal(count.rows[0].total, 1);
  assert.equal((await call('POST', '/api/attendance', tokens.managerA, { employeeId: ids.ali, date: '2026-02-30', status: 'Present' })).status, 400);
  assert.equal((await call('POST', '/api/attendance', tokens.managerA, { employeeId: ids.ali, date: '2026-01-15', status: 'Late' })).status, 400);
  assert.equal((await call('POST', '/api/attendance', tokens.managerA, { employeeId: ids.ali, date: '2099-01-01', status: 'Present' })).status, 400);
  const day = await call('GET', '/api/attendance?date=2026-01-15', tokens.managerA);
  assert.equal(day.status, 200);
  assert.equal(day.body.attendance.find((row: any) => row.employeeId === ids.ali).status, 'Absent');
  assert.equal(day.body.attendance.find((row: any) => row.employeeId === ids.sara).status, null);
  assert.equal((await call('POST', '/api/attendance', tokens.accountantA, { employeeId: ids.ali, status: 'Present' })).status, 403);
  assert.equal((await call('GET', '/api/attendance', tokens.accountantA)).status, 403);
});

test('salary advance: manager records it, accountant cannot', async () => {
  const advance = await call('POST', `/api/employees/${ids.ali}/advances`, tokens.managerA, { amount: 500, note: 'Rent help' });
  assert.equal(advance.status, 201);
  assert.equal((await call('POST', `/api/employees/${ids.ali}/advances`, tokens.accountantA, { amount: 50 })).status, 403);
  assert.equal((await call('POST', `/api/employees/${ids.ali}/advances`, tokens.managerA, { amount: 0 })).status, 400);
  const list = await call('GET', '/api/employees', tokens.managerA);
  assert.equal(num(list.body.employees.find((row: any) => row.id === ids.ali).advance), 500);
});

test('payroll: bonus, advance deduction and other deduction produce the net salary; duplicates and bad deductions are refused', async () => {
  const created = await call('POST', '/api/payroll', tokens.managerA, { employeeId: ids.ali, period: '2026-11', bonus: 200, advanceDeduction: 300, otherDeduction: 100, deductionNote: 'Late arrivals' });
  assert.equal(created.status, 201);
  ids.aliPayroll = created.body.payroll.id;
  assert.equal(num(created.body.payroll.netSalary), 2800);
  assert.equal(created.body.payroll.status, 'Unpaid');
  assert.equal(num(created.body.payroll.remaining), 2800);
  assert.equal((await call('POST', '/api/payroll', tokens.managerA, { employeeId: ids.ali, period: '2026-11' })).status, 409);
  assert.equal((await call('POST', '/api/payroll', tokens.accountantA, { employeeId: ids.sara, period: '2026-11' })).status, 403);
  assert.equal((await call('POST', '/api/payroll', tokens.managerA, { employeeId: ids.sara, period: '2026-13' })).status, 400);
  assert.equal((await call('POST', '/api/payroll', tokens.managerA, { employeeId: ids.sara, period: '2026-11', otherDeduction: 5000 })).status, 400);
  assert.equal((await call('POST', '/api/payroll', tokens.managerA, { employeeId: ids.sara, period: '2026-11', advanceDeduction: 50 })).status, 400);
  const list = await call('GET', '/api/employees', tokens.managerA);
  assert.equal(num(list.body.employees.find((row: any) => row.id === ids.ali).advance), 200);
});

test('salary payments: Cash and Mada only, partial then full, never above the remaining salary, history kept, audited', async () => {
  const path = `/api/payroll/${ids.aliPayroll}/payments`;
  const part = await call('POST', path, tokens.accountantA, { amount: 1000, method: 'Cash' });
  assert.equal(part.status, 201);
  assert.equal(part.body.payroll.status, 'Part-paid');
  assert.equal(num(part.body.payroll.remaining), 1800);
  assert.equal((await call('POST', path, tokens.accountantA, { amount: 100, method: 'Card' })).status, 400);
  assert.equal((await call('POST', path, tokens.accountantA, { amount: 2000, method: 'Cash' })).status, 400);
  assert.equal((await call('POST', path, tokens.accountantA, { amount: 0, method: 'Cash' })).status, 400);
  const rest = await call('POST', path, tokens.managerA, { amount: 1800, method: 'Mada' });
  assert.equal(rest.status, 201);
  assert.equal(rest.body.payroll.status, 'Paid');
  assert.equal(num(rest.body.payroll.remaining), 0);
  assert.equal((await call('POST', path, tokens.managerA, { amount: 1, method: 'Cash' })).status, 400);
  const listed = (await call('GET', '/api/payroll?period=2026-11', tokens.accountantA)).body.payroll.find((row: any) => row.id === ids.aliPayroll);
  assert.deepEqual(listed.payments.map((payment: any) => payment.paymentMethod), ['Cash', 'Mada']);
  assert.deepEqual(listed.payments.map((payment: any) => num(payment.amount)), [1000, 1800]);
  const rows = await db.query('SELECT count(*)::int AS total, SUM(amount)::float AS sum FROM payroll_payments WHERE payroll_id = $1', [ids.aliPayroll]);
  assert.equal(rows.rows[0].total, 2);
  assert.equal(rows.rows[0].sum, 2800);
  const audits = await db.query("SELECT count(*)::int AS total FROM audit_logs WHERE entity_id = $1 AND action = 'payroll.payment_recorded' AND user_id IS NOT NULL AND branch_id IS NOT NULL", [ids.aliPayroll]);
  assert.equal(audits.rows[0].total, 2);
});

test('two simultaneous payments cannot overpay the same payroll', async () => {
  const created = await call('POST', '/api/payroll', tokens.managerA, { employeeId: ids.sara, period: '2026-11' });
  assert.equal(created.status, 201);
  const path = `/api/payroll/${created.body.payroll.id}/payments`;
  const replies = await Promise.all([call('POST', path, tokens.accountantA, { amount: 1000, method: 'Cash' }), call('POST', path, tokens.managerA, { amount: 1000, method: 'Mada' })]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [201, 400]);
  const rows = await db.query('SELECT count(*)::int AS total, SUM(amount)::float AS sum FROM payroll_payments WHERE payroll_id = $1', [created.body.payroll.id]);
  assert.equal(rows.rows[0].total, 1);
  assert.equal(rows.rows[0].sum, 1000);
});

test('organization and branch scope: other organizations and other branches see and change nothing', async () => {
  for (const key of ['ownerB', 'managerA2']) {
    const employees = await call('GET', '/api/employees', tokens[key]);
    assert.equal(employees.status, 200, key);
    assert.equal(employees.body.employees.some((row: any) => row.id === ids.ali), false, key);
    const payroll = await call('GET', '/api/payroll', tokens[key]);
    assert.equal(payroll.body.payroll.length, 0, key);
    assert.equal((await call('POST', `/api/payroll/${ids.aliPayroll}/payments`, tokens[key], { amount: 1, method: 'Cash' })).status, 404, key);
    assert.equal((await call('POST', '/api/attendance', tokens[key], { employeeId: ids.ali, status: 'Present' })).status, 404, key);
    assert.equal((await call('PATCH', `/api/employees/${ids.ali}`, tokens[key], { shift: 'Night' })).status, 404, key);
    assert.equal((await call('POST', `/api/employees/${ids.ali}/advances`, tokens[key], { amount: 10 })).status, 404, key);
    assert.equal((await call('POST', `/api/employees/${ids.ali}/deactivate`, tokens[key])).status, 404, key);
  }
});

test('deactivate keeps payroll history, blocks new work, and can be reversed', async () => {
  assert.equal((await call('POST', `/api/employees/${ids.sara}/deactivate`, tokens.accountantA)).status, 403);
  const off = await call('POST', `/api/employees/${ids.sara}/deactivate`, tokens.managerA);
  assert.equal(off.status, 200);
  assert.equal(off.body.employee.active, false);
  assert.equal((await call('GET', '/api/employees', tokens.managerA)).body.employees.some((row: any) => row.id === ids.sara), false);
  const all = await call('GET', '/api/employees?includeInactive=true', tokens.managerA);
  assert.equal(all.body.employees.find((row: any) => row.id === ids.sara).active, false);
  assert.equal((await call('POST', '/api/attendance', tokens.managerA, { employeeId: ids.sara, status: 'Present' })).status, 404);
  assert.equal((await call('POST', '/api/payroll', tokens.managerA, { employeeId: ids.sara, period: '2026-12' })).status, 404);
  assert.equal((await call('GET', '/api/payroll', tokens.managerA)).body.payroll.some((row: any) => row.employeeId === ids.sara), true);
  assert.equal((await call('POST', `/api/employees/${ids.sara}/reactivate`, tokens.managerA)).status, 200);
  assert.equal((await call('POST', '/api/attendance', tokens.managerA, { employeeId: ids.sara, status: 'Present' })).status, 200);
});

test('every HR write left an audit log row with user and branch', async () => {
  const rows = await db.query('SELECT action, count(*)::int AS total FROM audit_logs WHERE organization_id = $1 AND user_id IS NOT NULL AND branch_id IS NOT NULL GROUP BY action', [ids.orgA]);
  const byAction = Object.fromEntries(rows.rows.map((row: any) => [row.action, row.total]));
  assert.equal(byAction['employee.created'], 2);
  assert.ok(byAction['employee.updated'] >= 1);
  assert.ok(byAction['attendance.updated'] >= 3);
  assert.equal(byAction['salary.advance_created'], 1);
  assert.equal(byAction['payroll.created'], 2);
  assert.equal(byAction['payroll.payment_recorded'], 3);
  assert.equal(byAction['employee.deactivated'], 1);
  assert.equal(byAction['employee.reactivated'], 1);
});

test('existing POS, inventory, supplier and expense endpoints still answer', async () => {
  assert.equal((await fetch(API + '/api/health')).status, 200);
  for (const path of ['/api/inventory', '/api/suppliers', '/api/expenses', '/api/payables']) {
    assert.equal((await call('GET', path, tokens.ownerA)).status, 200, path);
  }
});
