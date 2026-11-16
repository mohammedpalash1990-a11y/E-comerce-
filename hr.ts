import type { Express, RequestHandler, Response } from 'express';
import type { PoolClient, Pool } from 'pg';
import { z } from 'zod';
import {
  MAX_MONEY, PAYMENT_METHODS, allocateAdvanceDeduction, centsToDecimal, computeNetCents, hasAtMostTwoDecimals,
  isDateNotInFuture, isValidIsoDate, isValidPeriod, toCents
} from './payroll-math.js';

// Employee, attendance and payroll API. Every query is scoped to the signed-in user's organization AND branch,
// every write runs inside a transaction together with its audit log row, and all money is SAR paid by Cash or Mada.

export type HrDeps = {
  pool: Pool;
  inTransaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
  authenticate: RequestHandler;
  allow: (...roles: any[]) => RequestHandler;
  asyncRoute: (fn: (req: any, res: Response) => Promise<unknown>) => RequestHandler;
  audit: (client: PoolClient, user: any, action: string, entity: string, id: string | null, details?: unknown) => Promise<unknown>;
};

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const money = z.number().finite().max(MAX_MONEY).refine(hasAtMostTwoDecimals, { message: 'Use at most 2 decimal places' });
const positiveMoney = money.refine(value => value > 0, { message: 'Must be greater than zero' });
const nonNegativeMoney = money.refine(value => value >= 0, { message: 'Must not be negative' });
const isoDate = z.string().refine(isValidIsoDate, { message: 'Use a real date in YYYY-MM-DD format' });
const notFutureDate = isoDate.refine(value => isDateNotInFuture(value), { message: 'Date cannot be in the future' });
const period = z.string().refine(isValidPeriod, { message: 'Use YYYY-MM' });
const today = () => new Date().toISOString().slice(0, 10);

export const hrSchemas = {
  employeeCreate: z.object({
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(80).default('Staff'),
    shift: z.string().trim().min(1).max(80).default('Morning'),
    salary: nonNegativeMoney
  }),
  employeeUpdate: z.object({
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(80),
    shift: z.string().trim().min(1).max(80),
    salary: nonNegativeMoney
  }).partial().refine(value => Object.keys(value).length > 0, { message: 'Nothing to update' }),
  attendance: z.object({
    employeeId: z.string().uuid(),
    date: notFutureDate.optional(),
    status: z.enum(['Present', 'Absent', 'On Leave'])
  }),
  advance: z.object({ amount: positiveMoney, note: z.string().trim().max(300).default('Salary advance') }),
  payrollCreate: z.object({
    employeeId: z.string().uuid(),
    period,
    bonus: nonNegativeMoney.default(0),
    advanceDeduction: nonNegativeMoney.default(0),
    otherDeduction: nonNegativeMoney.default(0),
    deductionNote: z.string().trim().max(200).default('')
  }),
  payment: z.object({ amount: positiveMoney, method: z.enum(PAYMENT_METHODS), date: notFutureDate.optional() }),
  dateQuery: z.object({ date: isoDate.optional() }),
  periodQuery: z.object({ period: period.optional() })
};

const READ_ROLES = ['owner', 'manager', 'accountant'];
const MANAGE_ROLES = ['owner', 'manager'];
const PAY_ROLES = ['owner', 'manager', 'accountant'];

type Runner = (text: string, values: unknown[]) => Promise<{ rows: any[] }>;

const PAYROLL_SELECT = `SELECT p.id, p.employee_id AS "employeeId", e.name AS "employeeName", p.period,
    p.base_salary AS "baseSalary", p.bonus, p.advance_deduction AS "advanceDeduction", p.other_deduction AS "otherDeduction",
    p.deduction_note AS "deductionNote", p.net_salary AS "netSalary", p.created_at AS "createdAt",
    COALESCE(pay.paid, 0) AS paid, p.net_salary - COALESCE(pay.paid, 0) AS remaining,
    CASE WHEN p.net_salary - COALESCE(pay.paid, 0) <= 0 THEN 'Paid' WHEN COALESCE(pay.paid, 0) > 0 THEN 'Part-paid' ELSE 'Unpaid' END AS status,
    COALESCE(pay.payments, '[]'::json) AS payments
  FROM payroll_records p
  JOIN employees e ON e.id = p.employee_id
  LEFT JOIN LATERAL (
    SELECT SUM(pp.amount) AS paid,
      json_agg(json_build_object('id', pp.id, 'amount', pp.amount, 'paymentMethod', pp.method, 'date', pp.payment_date::text, 'createdAt', pp.created_at) ORDER BY pp.created_at, pp.id) AS payments
    FROM payroll_payments pp WHERE pp.payroll_id = p.id
  ) pay ON true`;

async function loadPayroll(run: Runner, where: string, values: unknown[]) {
  const result = await run(PAYROLL_SELECT + ' WHERE p.organization_id = $1 AND p.branch_id = $2 ' + where + ' ORDER BY p.period DESC, e.name', values);
  return result.rows;
}

export function registerHrRoutes(app: Express, deps: HrDeps): void {
  const { pool, inTransaction, authenticate, allow, asyncRoute, audit } = deps;
  const requireBranch: RequestHandler = (req: any, res, next) => {
    if (!req.user?.branchId) { res.status(403).json({ error: 'This account is not assigned to a branch' }); return; }
    next();
  };
  const guard = (...roles: string[]): RequestHandler[] => [authenticate, allow(...roles), requireBranch];
  const run = (client: PoolClient): Runner => (text, values) => client.query(text, values);
  const scope = (req: any) => [req.user.organizationId, req.user.branchId];

  app.get('/api/employees', ...guard(...READ_ROLES), asyncRoute(async (req, res) => {
    const query = hrSchemas.dateQuery.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid date' });
    const includeInactive = req.query.includeInactive === 'true' && MANAGE_ROLES.includes(req.user.role);
    const rows = await pool.query(
      `SELECT e.id, e.name, e.job_role AS role, e.shift, e.monthly_salary AS salary, e.active,
         COALESCE(a.status, 'Not marked') AS status,
         COALESCE((SELECT SUM(sa.amount - sa.deducted) FROM salary_advances sa WHERE sa.employee_id = e.id AND sa.organization_id = e.organization_id AND sa.branch_id = e.branch_id), 0) AS advance
       FROM employees e
       LEFT JOIN employee_attendance a ON a.employee_id = e.id AND a.attendance_date = $3::date
       WHERE e.organization_id = $1 AND e.branch_id = $2 AND ($4::boolean OR e.active = true)
       ORDER BY e.active DESC, e.name`,
      [...scope(req), query.data.date ?? today(), includeInactive]
    );
    res.json({ employees: rows.rows });
  }));

  app.post('/api/employees', ...guard(...MANAGE_ROLES), asyncRoute(async (req, res) => {
    const parsed = hrSchemas.employeeCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid employee data', details: parsed.error.flatten() });
    const d = parsed.data;
    const employee = await inTransaction(async client => {
      const row = await client.query(
        `INSERT INTO employees(organization_id, branch_id, name, job_role, shift, monthly_salary, created_by)
         VALUES($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, job_role AS role, shift, monthly_salary AS salary, active`,
        [...scope(req), d.name, d.role, d.shift, d.salary, req.user.id]
      );
      await audit(client, req.user, 'employee.created', 'employee', row.rows[0].id, d);
      return row.rows[0];
    });
    res.status(201).json({ employee: { ...employee, status: 'Not marked', advance: 0 } });
  }));

  app.patch('/api/employees/:id', ...guard(...MANAGE_ROLES), asyncRoute(async (req, res) => {
    const parsed = hrSchemas.employeeUpdate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid employee data', details: parsed.error.flatten() });
    const d = parsed.data;
    const employee = await inTransaction(async client => {
      const row = await client.query(
        `UPDATE employees SET name = COALESCE($1, name), job_role = COALESCE($2, job_role), shift = COALESCE($3, shift),
           monthly_salary = COALESCE($4::numeric, monthly_salary), updated_at = now()
         WHERE id = $5 AND organization_id = $6 AND branch_id = $7 AND active = true
         RETURNING id, name, job_role AS role, shift, monthly_salary AS salary, active`,
        [d.name ?? null, d.role ?? null, d.shift ?? null, d.salary ?? null, String(req.params.id), ...scope(req)]
      );
      if (!row.rowCount) throw fail(404, 'Employee not found');
      await audit(client, req.user, 'employee.updated', 'employee', row.rows[0].id, d);
      return row.rows[0];
    });
    res.json({ employee });
  }));

  const setActive = (active: boolean) => asyncRoute(async (req, res) => {
    const employee = await inTransaction(async client => {
      const row = await client.query(
        `UPDATE employees SET active = $1, updated_at = now()
         WHERE id = $2 AND organization_id = $3 AND branch_id = $4 AND active = $5
         RETURNING id, name, job_role AS role, shift, monthly_salary AS salary, active`,
        [active, String(req.params.id), ...scope(req), !active]
      );
      if (!row.rowCount) throw fail(404, active ? 'Inactive employee not found' : 'Employee not found');
      const advance = await client.query('SELECT COALESCE(SUM(amount - deducted), 0) AS outstanding FROM salary_advances WHERE employee_id = $1', [row.rows[0].id]);
      const unpaid = await client.query(
        `SELECT count(*)::int AS total FROM payroll_records p
         WHERE p.employee_id = $1 AND p.net_salary > COALESCE((SELECT SUM(pp.amount) FROM payroll_payments pp WHERE pp.payroll_id = p.id), 0)`,
        [row.rows[0].id]
      );
      const details = { outstandingAdvance: advance.rows[0].outstanding, unpaidPayrollRecords: unpaid.rows[0].total };
      await audit(client, req.user, active ? 'employee.reactivated' : 'employee.deactivated', 'employee', row.rows[0].id, details);
      return { ...row.rows[0], ...details };
    });
    res.json({ employee });
  });
  app.post('/api/employees/:id/deactivate', ...guard(...MANAGE_ROLES), setActive(false));
  app.post('/api/employees/:id/reactivate', ...guard(...MANAGE_ROLES), setActive(true));

  app.get('/api/attendance', ...guard(...MANAGE_ROLES), asyncRoute(async (req, res) => {
    const query = hrSchemas.dateQuery.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid date' });
    const date = query.data.date ?? today();
    const rows = await pool.query(
      `SELECT e.id AS "employeeId", e.name, e.job_role AS role, e.shift, a.status
       FROM employees e
       LEFT JOIN employee_attendance a ON a.employee_id = e.id AND a.attendance_date = $3::date
       WHERE e.organization_id = $1 AND e.branch_id = $2 AND e.active = true
       ORDER BY e.name`,
      [...scope(req), date]
    );
    res.json({ date, attendance: rows.rows });
  }));

  app.post('/api/attendance', ...guard(...MANAGE_ROLES), asyncRoute(async (req, res) => {
    const parsed = hrSchemas.attendance.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid attendance record', details: parsed.error.flatten() });
    const d = { ...parsed.data, date: parsed.data.date ?? today() };
    const attendance = await inTransaction(async client => {
      const employee = await client.query('SELECT id FROM employees WHERE id = $1 AND organization_id = $2 AND branch_id = $3 AND active = true', [d.employeeId, ...scope(req)]);
      if (!employee.rowCount) throw fail(404, 'Employee not found');
      const row = await client.query(
        `INSERT INTO employee_attendance(employee_id, organization_id, branch_id, attendance_date, status, created_by)
         VALUES($1, $2, $3, $4::date, $5, $6)
         ON CONFLICT(employee_id, attendance_date) DO UPDATE SET status = EXCLUDED.status, updated_at = now(), created_by = EXCLUDED.created_by
         RETURNING id, employee_id AS "employeeId", attendance_date::text AS date, status`,
        [d.employeeId, ...scope(req), d.date, d.status, req.user.id]
      );
      await audit(client, req.user, 'attendance.updated', 'employee', d.employeeId, d);
      return row.rows[0];
    });
    res.json({ attendance });
  }));

  app.post('/api/employees/:id/advances', ...guard(...MANAGE_ROLES), asyncRoute(async (req, res) => {
    const parsed = hrSchemas.advance.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid salary advance', details: parsed.error.flatten() });
    const d = parsed.data;
    const advance = await inTransaction(async client => {
      const employee = await client.query('SELECT id FROM employees WHERE id = $1 AND organization_id = $2 AND branch_id = $3 AND active = true', [String(req.params.id), ...scope(req)]);
      if (!employee.rowCount) throw fail(404, 'Employee not found');
      const row = await client.query(
        `INSERT INTO salary_advances(employee_id, organization_id, branch_id, amount, note, created_by)
         VALUES($1, $2, $3, $4, $5, $6) RETURNING id, amount, note, created_at AS "createdAt"`,
        [String(req.params.id), ...scope(req), d.amount, d.note, req.user.id]
      );
      await audit(client, req.user, 'salary.advance_created', 'salary_advance', row.rows[0].id, { ...d, employeeId: String(req.params.id) });
      return row.rows[0];
    });
    res.status(201).json({ advance });
  }));

  app.get('/api/payroll', ...guard(...READ_ROLES), asyncRoute(async (req, res) => {
    const query = hrSchemas.periodQuery.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid payroll month' });
    const payroll = query.data.period
      ? await loadPayroll((t, v) => pool.query(t, v), 'AND p.period = $3', [...scope(req), query.data.period])
      : await loadPayroll((t, v) => pool.query(t, v), '', scope(req));
    res.json({ payroll });
  }));

  app.post('/api/payroll', ...guard(...MANAGE_ROLES), asyncRoute(async (req, res) => {
    const parsed = hrSchemas.payrollCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payroll data', details: parsed.error.flatten() });
    const d = parsed.data;
    const record = await inTransaction(async client => {
      // Locking the employee row serialises payroll creation and advance deduction for this employee.
      const employee = await client.query('SELECT id, name, monthly_salary FROM employees WHERE id = $1 AND organization_id = $2 AND branch_id = $3 AND active = true FOR UPDATE', [d.employeeId, ...scope(req)]);
      if (!employee.rowCount) throw fail(404, 'Employee not found');
      const existing = await client.query('SELECT 1 FROM payroll_records WHERE employee_id = $1 AND period = $2', [d.employeeId, d.period]);
      if (existing.rowCount) throw fail(409, 'Payroll already exists for this employee and month');
      const baseCents = toCents(employee.rows[0].monthly_salary);
      const bonusCents = toCents(d.bonus);
      const advanceDeductionCents = toCents(d.advanceDeduction);
      const otherDeductionCents = toCents(d.otherDeduction);
      const netCents = computeNetCents({ baseCents, bonusCents, advanceDeductionCents, otherDeductionCents });
      if (netCents < 0) throw fail(400, 'Deductions cannot be more than salary plus bonus');
      const advances = await client.query(
        'SELECT id, amount, deducted FROM salary_advances WHERE employee_id = $1 AND organization_id = $2 AND branch_id = $3 AND amount > deducted ORDER BY created_at, id FOR UPDATE',
        [d.employeeId, ...scope(req)]
      );
      const allocation = allocateAdvanceDeduction(
        advances.rows.map(row => ({ id: String(row.id), outstandingCents: toCents(row.amount) - toCents(row.deducted) })),
        advanceDeductionCents
      );
      if (!allocation) throw fail(400, 'Advance deduction is more than the outstanding advance');
      for (const part of allocation) await client.query('UPDATE salary_advances SET deducted = deducted + $1::numeric WHERE id = $2', [centsToDecimal(part.takeCents), part.id]);
      const inserted = await client.query(
        `INSERT INTO payroll_records(employee_id, organization_id, branch_id, period, base_salary, bonus, advance_deduction, other_deduction, deduction_note, net_salary, created_by)
         VALUES($1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9, $10::numeric, $11) RETURNING id`,
        [d.employeeId, ...scope(req), d.period, centsToDecimal(baseCents), centsToDecimal(bonusCents), centsToDecimal(advanceDeductionCents), centsToDecimal(otherDeductionCents), d.deductionNote, centsToDecimal(netCents), req.user.id]
      );
      await audit(client, req.user, 'payroll.created', 'payroll', inserted.rows[0].id, { ...d, employeeName: employee.rows[0].name, netSalary: centsToDecimal(netCents) });
      const rows = await loadPayroll(run(client), 'AND p.id = $3', [...scope(req), inserted.rows[0].id]);
      return rows[0];
    });
    res.status(201).json({ payroll: record });
  }));

  app.post('/api/payroll/:id/payments', ...guard(...PAY_ROLES), asyncRoute(async (req, res) => {
    const parsed = hrSchemas.payment.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payroll payment', details: parsed.error.flatten() });
    const d = { ...parsed.data, date: parsed.data.date ?? today() };
    const result = await inTransaction(async client => {
      // The row lock makes two simultaneous payments for the same payroll wait for each other, so neither can overpay.
      const payroll = await client.query(
        `SELECT p.id, p.net_salary, p.period, e.name AS employee_name FROM payroll_records p JOIN employees e ON e.id = p.employee_id
         WHERE p.id = $1 AND p.organization_id = $2 AND p.branch_id = $3 FOR UPDATE OF p`,
        [String(req.params.id), ...scope(req)]
      );
      if (!payroll.rowCount) throw fail(404, 'Payroll record not found');
      const paid = await client.query('SELECT COALESCE(SUM(amount), 0) AS total FROM payroll_payments WHERE payroll_id = $1', [String(req.params.id)]);
      const remainingCents = toCents(payroll.rows[0].net_salary) - toCents(paid.rows[0].total);
      const amountCents = toCents(d.amount);
      if (remainingCents <= 0) throw fail(400, 'This payroll is already fully paid');
      if (amountCents > remainingCents) throw fail(400, 'Payment exceeds remaining salary');
      const row = await client.query(
        `INSERT INTO payroll_payments(payroll_id, organization_id, branch_id, amount, method, payment_date, created_by)
         VALUES($1, $2, $3, $4::numeric, $5, $6::date, $7)
         RETURNING id, amount, method AS "paymentMethod", payment_date::text AS date, created_at AS "createdAt"`,
        [String(req.params.id), ...scope(req), centsToDecimal(amountCents), d.method, d.date, req.user.id]
      );
      await audit(client, req.user, 'payroll.payment_recorded', 'payroll', String(req.params.id), {
        paymentId: row.rows[0].id, employeeName: payroll.rows[0].employee_name, period: payroll.rows[0].period,
        amount: centsToDecimal(amountCents), method: d.method, currency: 'SAR', remainingAfter: centsToDecimal(remainingCents - amountCents)
      });
      const rows = await loadPayroll(run(client), 'AND p.id = $3', [...scope(req), String(req.params.id)]);
      return { payment: row.rows[0], payroll: rows[0] };
    });
    res.status(201).json(result);
  }));
}
