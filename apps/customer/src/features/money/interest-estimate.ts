import { formatAmount, parseAmount } from '../../shared/money';

/**
 * Estimated interest, worked out only from two figures: what the customer typed and the rate the bank returned.
 *
 *   Earn  (simple):          interest = amount x APR x days / 365
 *   Loans (daily compounding): each day, debt += floor(floor(debt x APR) / 365), for 365 days; interest = debt - amount
 *
 * The loan rule mirrors how the bank charges (it adds each day's interest to the debt, so the next day is charged on the
 * larger balance, rounding every day down). Whole figures in basis points and scaled integers, never floats. The result
 * is cut down (never rounded up) to the asset's display places. It is an estimate: the real amount depends on repayments.
 */
export const DAYS_PER_YEAR = 365;
const DOLLAR_COINS = new Set(['USDT', 'USDC', 'USD']);
const SCALE_PLACES = 18;

/** Decimals shown for an estimate in this asset: cents for dollar coins, eight places otherwise. */
export function displayPlaces(asset: string): number {
  return DOLLAR_COINS.has(asset) ? 2 : 8;
}

export type InterestEstimate = {
  interest: string;
  days: number;
  /** True when interest is above zero but too small to show at this many places: say "less than" instead of "0". */
  belowDisplay: boolean;
  /** The smallest amount that can be shown at this many places ("0.01"). */
  smallest: string;
};

export function estimateInterest(input: {
  amount: string;
  aprBps: number;
  days: number;
  compounding?: 'simple' | 'daily';
  places?: number;
}): InterestEstimate | null {
  if (!Number.isInteger(input.aprBps) || input.aprBps < 0 || !Number.isInteger(input.days) || input.days <= 0) return null;
  let amount: bigint;
  try {
    amount = parseAmount(input.amount.trim());
  } catch {
    return null;
  }
  if (amount <= 0n) return null;
  let raw: bigint;
  if (input.compounding === 'daily') {
    let debt = amount;
    for (let day = 0; day < input.days; day++) debt += (debt * BigInt(input.aprBps)) / 10_000n / BigInt(DAYS_PER_YEAR);
    raw = debt - amount;
  } else {
    raw = (amount * BigInt(input.aprBps) * BigInt(input.days)) / (10_000n * BigInt(DAYS_PER_YEAR));
  }
  const places = Math.min(Math.max(input.places ?? 8, 0), SCALE_PLACES);
  const cut = 10n ** BigInt(SCALE_PLACES - places);
  const floored = (raw / cut) * cut;
  return {
    interest: formatAmount(floored),
    days: input.days,
    belowDisplay: raw > 0n && floored === 0n,
    smallest: formatAmount(cut),
  };
}

/** `days` for a pool or loan: the pool's term when it has one, otherwise one year. */
export function estimateDays(termDays: number | null): number {
  return termDays !== null && termDays > 0 ? termDays : DAYS_PER_YEAR;
}
