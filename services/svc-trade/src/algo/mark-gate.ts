import { formatAmount, type Amount } from '@intafaced/ledger-client';
import type { AlgoQuotedMark } from './types.js';

/**
 * ALGO MARK GATE — same vocabulary as `svc-bank/src/loans/prices.ts` /
 * `futures/mark-policy.ts`, algo namespace. D-S-04 §5: do not respell.
 *
 * A blank / stale / non-positive / future-dated mark HALTS the schedule.
 * There is no fallback price and no invent path.
 */

export interface AlgoMarkPolicy {
  readonly maxAgeSeconds: number;
}

export const DEFAULT_ALGO_MARK_POLICY: AlgoMarkPolicy = {
  maxAgeSeconds: 300,
};

export const ALGO_MARK_UNUSABLE = 'trade.algo_mark_unusable' as const;
export const ALGO_MARK_MISSING = 'trade.algo_mark_missing' as const;
export const ALGO_MARK_INVALID = 'trade.algo_mark_invalid' as const;

export type AlgoMarkErrorCode = typeof ALGO_MARK_UNUSABLE | typeof ALGO_MARK_MISSING | typeof ALGO_MARK_INVALID;

export interface AlgoMarkCheck {
  readonly ok: boolean;
  readonly reason?: string;
  readonly code?: AlgoMarkErrorCode;
}

const OK: AlgoMarkCheck = { ok: true };

/** Fit to size / place a child against — marking bar, not liquidation. */
export function acceptableForAlgo(mark: AlgoQuotedMark, now: Date, policy: AlgoMarkPolicy = DEFAULT_ALGO_MARK_POLICY): AlgoMarkCheck {
  if (mark.price <= 0n) {
    return {
      ok: false,
      code: ALGO_MARK_INVALID,
      reason: `${mark.marketId}: non-positive mark ${formatAmount(mark.price)}`,
    };
  }

  const ageSeconds = (now.getTime() - mark.asOf.getTime()) / 1_000;
  // An Invalid Date makes age NaN, and NaN fails both comparisons below.
  if (Number.isNaN(ageSeconds)) {
    return {
      ok: false,
      code: ALGO_MARK_UNUSABLE,
      reason: `${mark.marketId}: mark asOf is not a valid date`,
    };
  }
  if (ageSeconds > policy.maxAgeSeconds) {
    return {
      ok: false,
      code: ALGO_MARK_UNUSABLE,
      reason: `${mark.marketId}: mark is ${Math.round(ageSeconds)}s old, limit ${policy.maxAgeSeconds}s`,
    };
  }
  if (ageSeconds < -30) {
    return {
      ok: false,
      code: ALGO_MARK_UNUSABLE,
      reason: `${mark.marketId}: mark is dated ${Math.round(-ageSeconds)}s in the future`,
    };
  }
  return OK;
}

export function algoMarkMissing(marketId: string): AlgoMarkCheck {
  return {
    ok: false,
    code: ALGO_MARK_MISSING,
    reason: `${marketId}: no mark available — refusing algo slice rather than inventing a price`,
  };
}

/** Buy: ask ≤ limit. Sell: bid ≥ limit. */
export function withinPriceBand(side: 'buy' | 'sell', reference: Amount, limit: Amount | null): boolean {
  if (limit === null) return true;
  if (side === 'buy') return reference <= limit;
  return reference >= limit;
}
