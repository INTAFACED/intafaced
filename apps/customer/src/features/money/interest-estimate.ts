import { formatAmount, parseAmount } from '../../shared/money';

/**
 * Estimated interest, worked out only from two figures: what the customer typed and the rate the bank returned.
 *
 *   interest = amount x APR x days / 365      (simple interest, no compounding)
 *
 * Whole figures in basis points and scaled integers, never floats. The result is cut down (never rounded up) to
 * `PLACES` decimals. It is an estimate: the bank accrues one day at a time and pays what it posts.
 */
export const DAYS_PER_YEAR = 365;
const PLACES = 8;
const CUT = 10n ** BigInt(18 - PLACES);

export type InterestEstimate = { interest: string; days: number };

export function estimateInterest(input: { amount: string; aprBps: number; days: number }): InterestEstimate | null {
  if (!Number.isInteger(input.aprBps) || input.aprBps < 0 || !Number.isInteger(input.days) || input.days <= 0) return null;
  let amount: bigint;
  try {
    amount = parseAmount(input.amount.trim());
  } catch {
    return null;
  }
  if (amount <= 0n) return null;
  const raw = (amount * BigInt(input.aprBps) * BigInt(input.days)) / (10_000n * BigInt(DAYS_PER_YEAR));
  return { interest: formatAmount((raw / CUT) * CUT), days: input.days };
}

/** `days` for a pool or loan: the pool's term when it has one, otherwise one year. */
export function estimateDays(termDays: number | null): number {
  return termDays !== null && termDays > 0 ? termDays : DAYS_PER_YEAR;
}
