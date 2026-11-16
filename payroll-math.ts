// Pure helpers for Employee / Attendance / Payroll. No imports on purpose: these run in the API and in unit tests.
// All money is SAR. Amounts are handled as integer halalas ("cents") to avoid floating point drift.

export const MAX_MONEY = 10_000_000;
export const PAYMENT_METHODS = ['Cash', 'Mada'] as const;
export type SalaryPaymentMethod = (typeof PAYMENT_METHODS)[number];
export type PayrollStatus = 'Unpaid' | 'Part-paid' | 'Paid';

/** True when a JSON number has at most two decimal places (SAR has 100 halalas). */
export function hasAtMostTwoDecimals(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/** Converts a SAR amount (number or PostgreSQL numeric string) to integer halalas. */
export function toCents(value: number | string): number {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(amount)) throw new Error('Invalid money amount');
  return Math.round(amount * 100);
}

/** Converts integer halalas to a fixed two-decimal SAR string, e.g. 123450 -> "1234.50". */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

export type NetSalaryParts = { baseCents: number; bonusCents: number; advanceDeductionCents: number; otherDeductionCents: number };

/** Net payable = base + bonus - advance deduction - other deduction. */
export function computeNetCents(parts: NetSalaryParts): number {
  return parts.baseCents + parts.bonusCents - parts.advanceDeductionCents - parts.otherDeductionCents;
}

/** Paid when nothing is left to pay, Part-paid when something was paid, otherwise Unpaid. */
export function payrollStatus(netCents: number, paidCents: number): PayrollStatus {
  if (paidCents >= netCents) return 'Paid';
  if (paidCents > 0) return 'Part-paid';
  return 'Unpaid';
}

export type OutstandingAdvance = { id: string; outstandingCents: number };
export type AdvanceAllocation = { id: string; takeCents: number };

/**
 * Deducts an amount from outstanding advances oldest-first (callers pass them sorted).
 * Returns null when the deduction is more than what is outstanding.
 */
export function allocateAdvanceDeduction(advances: OutstandingAdvance[], deductCents: number): AdvanceAllocation[] | null {
  const outstanding = advances.reduce((sum, advance) => sum + advance.outstandingCents, 0);
  if (deductCents > outstanding) return null;
  const result: AdvanceAllocation[] = [];
  let remaining = deductCents;
  for (const advance of advances) {
    if (remaining <= 0) break;
    const take = Math.min(advance.outstandingCents, remaining);
    if (take > 0) { result.push({ id: advance.id, takeCents: take }); remaining -= take; }
  }
  return result;
}

/** Real calendar date in YYYY-MM-DD form (rejects 2026-02-31 and similar). */
export function isValidIsoDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Payroll month in YYYY-MM form. */
export function isValidPeriod(value: string): boolean {
  return /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value);
}

/**
 * Attendance and payments may be recorded for any past date and for today. One day of slack covers the gap between the
 * browser's local date (Saudi time) and the server's UTC date.
 */
export function isDateNotInFuture(value: string, now: Date = new Date()): boolean {
  if (!isValidIsoDate(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const requested = Date.UTC(year, month - 1, day);
  const limit = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 24 * 60 * 60 * 1000;
  return requested <= limit;
}
