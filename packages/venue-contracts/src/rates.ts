import type { Amount } from '@intafaced/ledger-client/money';

/**
 * FUNDING, BORROW AND TRADE PRINTS — the rest of §27's unified schema.
 *
 * These are the fields a cross-venue basis or funding-capture program (§28) is
 * made of, and each one is a place a `number` would quietly ruin the arithmetic.
 *
 * ── Rates are scaled fractions, not percentages ─────────────────────────────
 *
 * A funding rate of one basis point is `parseAmount('0.0001')`, not `0.01` and
 * not `1`. Three reasons it is an `Amount` rather than a bps integer like a fee:
 *
 *   · Funding rates are quoted to eight significant figures by venues that
 *     settle them eight-hourly on nine-figure open interest. A bps integer
 *     truncates the digits the whole trade lives in.
 *   · They go NEGATIVE, and the sign is the trade. `Amount` is a signed bigint.
 *   · Applying one is `mul(notional, rate)` in a single scale, with the
 *     platform's own rounding rules, rather than a bespoke divide by 10,000.
 */

export interface FundingRate {
  readonly venueId: string;
  readonly symbol: string;
  /**
   * The rate applied at the NEXT settlement, as a signed scaled fraction.
   *
   * Positive: longs pay shorts. This convention is stated because venues do not
   * agree on it in their own documentation, and a sign error in a funding
   * program is a position that loses money in exactly the way it was built to
   * make it.
   */
  readonly rate: Amount;
  /** Seconds between settlements — 28,800 on an eight-hourly venue. */
  readonly intervalSeconds: number;
  readonly nextFundingAt: Date;
  /** The venue's mark price, which is what funding is charged against. */
  readonly markPrice: Amount | null;
  /** The venue's index (spot reference). The mark-index gap is the basis. */
  readonly indexPrice: Amount | null;
  /** When THIS PROCESS read it. */
  readonly observedAt: Date;
}

export interface BorrowRate {
  readonly venueId: string;
  readonly asset: string;
  /** Hourly interest as a signed scaled fraction. See the header. */
  readonly hourlyRate: Amount;
  /** How much of the asset is actually borrowable right now. `null` if unpublished. */
  readonly available: Amount | null;
  readonly observedAt: Date;
}

/**
 * One public trade print from a venue.
 *
 * `takerSide` is nullable because a large minority of venues do not publish it,
 * and inferring it from the last book state is a guess that looks like a fact.
 * A null aggressor is a true statement; a wrong one poisons every volume-side
 * signal computed downstream.
 */
export interface VenueTrade {
  readonly venueId: string;
  readonly symbol: string;
  /** The venue's own print id, where it publishes one. Used to dedupe on reconnect. */
  readonly tradeId: string | null;
  readonly price: Amount;
  readonly amount: Amount;
  readonly takerSide: 'buy' | 'sell' | null;
  /** The venue's stated print time. */
  readonly tradedAt: Date;
  /** When THIS PROCESS read it. The gap between the two is feed lag. */
  readonly observedAt: Date;
}

/**
 * Annualised funding, as a signed scaled fraction, for comparing venues.
 *
 * The comparison the basis desk actually makes: a venue paying 0.01% eight-hourly
 * and one paying 0.003% hourly are not obviously rankable until both are on the
 * same clock.
 *
 * Integer arithmetic throughout — `periods` is exact for every interval any
 * venue uses, and the multiply happens in ledger-client's scale.
 *
 * Zero is a real annualised rate when the venue published a zero rate on a real
 * clock. A blank, zero, negative, infinite, NaN, or too-large interval is not
 * that print. Reporting it as `0n` would invent a yearly rate.
 */
const SECONDS_PER_YEAR = 31_536_000;

/** A funding interval that cannot be turned into a yearly rate. */
export class FundingIntervalError extends Error {
  constructor(readonly intervalSeconds: unknown) {
    super(`funding interval ${describeInterval(intervalSeconds)} cannot be annualised — refused, not a zero rate`);
    this.name = 'FundingIntervalError';
  }
}

function describeInterval(intervalSeconds: unknown): string {
  if (intervalSeconds === undefined || intervalSeconds === null) return 'blank';
  if (typeof intervalSeconds === 'string' && intervalSeconds.trim() === '') return 'blank';
  if (typeof intervalSeconds === 'number' && Number.isNaN(intervalSeconds)) return 'NaN';
  return String(intervalSeconds);
}

/**
 * Settlements in a 365-day year, or `null` when the interval is not a clock
 * those settlements can be counted on.
 */
function periodsPerYear(intervalSeconds: unknown): bigint | null {
  if (typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return null;
  }
  const periods = Math.floor(SECONDS_PER_YEAR / intervalSeconds);
  // Zero periods is an interval longer than a year. A non-safe count is an
  // interval so small that the settlement tally is not an integer bigint.
  if (!Number.isSafeInteger(periods) || periods < 1) return null;
  return BigInt(periods);
}

export function annualisedFundingRate(funding: Pick<FundingRate, 'rate' | 'intervalSeconds'>): Amount {
  const periods = periodsPerYear(funding.intervalSeconds);
  if (periods === null) throw new FundingIntervalError(funding.intervalSeconds);
  return funding.rate * periods;
}
