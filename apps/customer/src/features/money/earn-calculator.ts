import { formatAmount, parseAmount } from '../../shared/money';

/**
 * The pool page's calculator (BK-earn-03, crypto-credit-earn-045, J-bank-08 #3): what an amount earns in a pool, worked
 * out the way the bank pays it, so the figure shown is the figure paid.
 *
 *   each day:  floor( floor(amount x rate in bps / 10,000) / 365 )
 *   over N days: N x that day
 *
 * The bank pays simple interest once a day on what is saved, rounding each day down in the reserve's favour
 * (svc-bank `dailyInterest`); the interest goes to the main balance, so nothing compounds. Scaled integers only.
 * It holds while the rate stays as it is: a new rate pays from the first full UTC day after it is recorded.
 */
export const DAYS_PER_YEAR = 365;
export const CALCULATOR_MAX_DAYS = 3650;

export type EarnCalculation = { perDay: string; total: string; days: number };

export function earnCalculation(input: { amount: string; aprBps: number; days: number }): EarnCalculation | null {
  if (!Number.isInteger(input.aprBps) || input.aprBps < 0) return null;
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > CALCULATOR_MAX_DAYS) return null;
  let principal: bigint;
  try {
    principal = parseAmount(input.amount.trim());
  } catch {
    return null;
  }
  if (principal <= 0n) return null;
  const annual = (principal * BigInt(input.aprBps)) / 10_000n;
  const perDay = annual / BigInt(DAYS_PER_YEAR);
  return { perDay: formatAmount(perDay), total: formatAmount(perDay * BigInt(input.days)), days: input.days };
}
