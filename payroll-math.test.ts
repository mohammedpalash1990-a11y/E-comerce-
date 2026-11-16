import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  allocateAdvanceDeduction, centsToDecimal, computeNetCents, hasAtMostTwoDecimals, isDateNotInFuture,
  isValidIsoDate, isValidPeriod, payrollStatus, toCents
} from '../../server/payroll-math.js';

test('money converts to integer halalas without floating point drift', () => {
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents('1234.56'), 123456);
  assert.equal(toCents('0.07'), 7);
  assert.equal(centsToDecimal(123450), '1234.50');
  assert.equal(centsToDecimal(5), '0.05');
  assert.equal(centsToDecimal(0), '0.00');
  assert.throws(() => toCents(Number.NaN));
});

test('amounts allow at most two decimals', () => {
  assert.equal(hasAtMostTwoDecimals(10.25), true);
  assert.equal(hasAtMostTwoDecimals(0.1 + 0.2), true);
  assert.equal(hasAtMostTwoDecimals(10.255), false);
  assert.equal(hasAtMostTwoDecimals(Number.POSITIVE_INFINITY), false);
});

test('net salary = base + bonus - advance deduction - other deduction', () => {
  assert.equal(computeNetCents({ baseCents: 300000, bonusCents: 20000, advanceDeductionCents: 30000, otherDeductionCents: 10000 }), 280000);
  assert.equal(computeNetCents({ baseCents: 100000, bonusCents: 0, advanceDeductionCents: 0, otherDeductionCents: 0 }), 100000);
});

test('status is Unpaid, Part-paid or Paid', () => {
  assert.equal(payrollStatus(280000, 0), 'Unpaid');
  assert.equal(payrollStatus(280000, 100000), 'Part-paid');
  assert.equal(payrollStatus(280000, 279999), 'Part-paid');
  assert.equal(payrollStatus(280000, 280000), 'Paid');
  assert.equal(payrollStatus(0, 0), 'Paid');
});

test('two small payments add up exactly to the salary (0.10 + 0.20 = 0.30)', () => {
  const paid = toCents(0.1) + toCents(0.2);
  assert.equal(payrollStatus(toCents(0.3), paid), 'Paid');
});

test('advance deduction is taken oldest-first and never exceeds what is outstanding', () => {
  const advances = [{ id: 'a1', outstandingCents: 20000 }, { id: 'a2', outstandingCents: 30000 }];
  assert.deepEqual(allocateAdvanceDeduction(advances, 0), []);
  assert.deepEqual(allocateAdvanceDeduction(advances, 15000), [{ id: 'a1', takeCents: 15000 }]);
  assert.deepEqual(allocateAdvanceDeduction(advances, 35000), [{ id: 'a1', takeCents: 20000 }, { id: 'a2', takeCents: 15000 }]);
  assert.deepEqual(allocateAdvanceDeduction(advances, 50000), [{ id: 'a1', takeCents: 20000 }, { id: 'a2', takeCents: 30000 }]);
  assert.equal(allocateAdvanceDeduction(advances, 50001), null);
});

test('dates and payroll months are validated as real calendar values', () => {
  assert.equal(isValidIsoDate('2026-11-07'), true);
  assert.equal(isValidIsoDate('2024-02-29'), true);
  assert.equal(isValidIsoDate('2026-02-31'), false);
  assert.equal(isValidIsoDate('2026-13-01'), false);
  assert.equal(isValidIsoDate('2026-1-1'), false);
  assert.equal(isValidPeriod('2026-11'), true);
  assert.equal(isValidPeriod('2026-12'), true);
  assert.equal(isValidPeriod('2026-13'), false);
  assert.equal(isValidPeriod('2026-00'), false);
  assert.equal(isValidPeriod('26-11'), false);
});

test('attendance and payment dates may be past, today or one day ahead (time zone slack), not further', () => {
  const now = new Date('2026-11-07T10:00:00Z');
  assert.equal(isDateNotInFuture('2020-01-01', now), true);
  assert.equal(isDateNotInFuture('2026-11-07', now), true);
  assert.equal(isDateNotInFuture('2026-11-08', now), true);
  assert.equal(isDateNotInFuture('2026-11-09', now), false);
  assert.equal(isDateNotInFuture('2026-02-31', now), false);
});

test('regression: no doubly escaped digit class (the original bug) in the new HR code or migration 003', () => {
  const doubleEscaped = '\\\\d';
  for (const file of ['server/hr.ts', 'server/payroll-math.ts', 'server/index.ts', 'db/migrations/003_payroll_hardening.sql']) {
    const source = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    const executable = source.split('\n').filter(line => !line.trim().startsWith('--') && !line.trim().startsWith('//')).join('\n');
    assert.equal(executable.includes(doubleEscaped), false, file + ' contains a doubly escaped \\d');
  }
  const fix = readFileSync(new URL('../../db/migrations/003_payroll_hardening.sql', import.meta.url), 'utf8');
  assert.match(fix, /DROP CONSTRAINT IF EXISTS payroll_records_period_check/);
});
