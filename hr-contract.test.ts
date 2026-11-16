import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hrSchemas } from '../../server/hr.js';

const read = (file: string) => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
const uuid = '11111111-1111-4111-8111-111111111111';

test('employee input: SAR amounts only, two decimals, defaults for role and shift', () => {
  const ok = hrSchemas.employeeCreate.parse({ name: ' Ali ', salary: 2500.5 });
  assert.deepEqual(ok, { name: 'Ali', role: 'Staff', shift: 'Morning', salary: 2500.5 });
  assert.equal(hrSchemas.employeeCreate.safeParse({ name: 'Ali', salary: -1 }).success, false);
  assert.equal(hrSchemas.employeeCreate.safeParse({ name: 'Ali', salary: 10.005 }).success, false);
  assert.equal(hrSchemas.employeeCreate.safeParse({ name: '', salary: 100 }).success, false);
  assert.equal(hrSchemas.employeeUpdate.safeParse({}).success, false);
  assert.equal(hrSchemas.employeeUpdate.safeParse({ shift: 'Night' }).success, true);
});

test('salary payments accept Cash and Mada only and must be positive', () => {
  assert.equal(hrSchemas.payment.safeParse({ amount: 100, method: 'Cash' }).success, true);
  assert.equal(hrSchemas.payment.safeParse({ amount: 100, method: 'Mada' }).success, true);
  for (const method of ['Card', 'Digital', 'Bank transfer', 'cash', '']) assert.equal(hrSchemas.payment.safeParse({ amount: 100, method }).success, false, method);
  assert.equal(hrSchemas.payment.safeParse({ amount: 0, method: 'Cash' }).success, false);
  assert.equal(hrSchemas.payment.safeParse({ amount: -5, method: 'Cash' }).success, false);
  assert.equal(hrSchemas.payment.safeParse({ amount: 10.001, method: 'Mada' }).success, false);
  assert.equal(hrSchemas.payment.safeParse({ amount: 100, method: 'Cash', date: '2026-02-31' }).success, false);
  assert.equal(hrSchemas.payment.safeParse({ amount: 100, method: 'Cash', date: '2099-01-01' }).success, false);
});

test('attendance accepts only Present, Absent, On Leave on real, non-future dates', () => {
  for (const status of ['Present', 'Absent', 'On Leave']) assert.equal(hrSchemas.attendance.safeParse({ employeeId: uuid, status, date: '2026-01-15' }).success, true, status);
  assert.equal(hrSchemas.attendance.safeParse({ employeeId: uuid, status: 'Late' }).success, false);
  assert.equal(hrSchemas.attendance.safeParse({ employeeId: 'not-a-uuid', status: 'Present' }).success, false);
  assert.equal(hrSchemas.attendance.safeParse({ employeeId: uuid, status: 'Present', date: '2026-02-30' }).success, false);
  assert.equal(hrSchemas.attendance.safeParse({ employeeId: uuid, status: 'Present', date: '2099-01-01' }).success, false);
});

test('payroll input: valid month, non-negative bonus and deductions defaulting to zero', () => {
  const ok = hrSchemas.payrollCreate.parse({ employeeId: uuid, period: '2026-11' });
  assert.deepEqual(ok, { employeeId: uuid, period: '2026-11', bonus: 0, advanceDeduction: 0, otherDeduction: 0, deductionNote: '' });
  assert.equal(hrSchemas.payrollCreate.safeParse({ employeeId: uuid, period: '2026-13' }).success, false);
  assert.equal(hrSchemas.payrollCreate.safeParse({ employeeId: uuid, period: '2026-11', bonus: -1 }).success, false);
  assert.equal(hrSchemas.payrollCreate.safeParse({ employeeId: uuid, period: '2026-11', otherDeduction: -1 }).success, false);
});

test('every HR route sits behind authentication, role check and branch guard', () => {
  const source = read('server/hr.ts');
  const routes = source.split('\n').filter(line => /app\.(get|post|patch|delete|put)\('\/api\//.test(line));
  assert.ok(routes.length >= 10, 'expected the HR routes to be registered');
  for (const line of routes) assert.match(line, /guard\(/, line.trim());
  assert.match(source, /organization_id/);
  assert.match(source, /branch_id/);
});

test('there is no /api/sync or /api/bootstrap route that could wipe HR data or expose payroll', () => {
  for (const file of ['server/index.ts', 'server/hr.ts']) {
    const source = read(file);
    assert.equal(/['"`]\/api\/(sync|bootstrap)/.test(source), false, file);
  }
});

test('the old inline HR routes were removed from index.ts and replaced by the HR module', () => {
  const index = read('server/index.ts');
  assert.match(index, /registerHrRoutes\(app,/);
  assert.equal(index.includes("'/api/payroll"), false);
  assert.equal(index.includes("'/api/employees"), false);
  assert.equal(index.includes("'/api/attendance"), false);
});
