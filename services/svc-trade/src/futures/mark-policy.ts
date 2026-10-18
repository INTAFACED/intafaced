/**
 * FUTURES MARK POLICY — when a price is allowed to move money on a perp.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT A NEW VOCABULARY. IT IS THE ONE FROM `prices.ts`, IN FUTURES.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `services/svc-bank/src/loans/prices.ts` already decided when a mark may move
 * someone's money, and `docs/adr/2026-08-04-bank-vertical-law.md` binds futures
 * to that decision. `docs/adr/2026-08-05-futures-risk-and-mark-law.md` is the
 * other half of the sentence: same `MarkQuality`, same four-field `MarkPolicy`,
 * same split `acceptableForMarking` / `acceptableForLiquidation` gates, same
 * meanings — with futures' own error codes in futures' own namespace.
 *
 * It is a MIRROR, not an import. svc-bank is another service and another
 * agent's; reaching into its source would be the cross-service coupling §2
 * forbids, and a shared package for four numbers and two predicates would be
 * worse than either. Where the two files disagree, `prices.ts` is the original
 * and this one is wrong.
 *
 * ── The three properties that carry across, each already argued once ─────────
 *
 * THE ASYMMETRY. Warnings tolerate a stale mark; seizures do not. `prices.ts`:
 * "Refusing to warn a borrower because the feed is 40 seconds old leaves them
 * uninformed; refusing to SELL on the same mark leaves them with their
 * collateral." On a perp: a margin-call notice may use a slightly stale mark, a
 * liquidation may not. Hence two staleness limits, not one.
 *
 * `last` IS NOT A LIQUIDATION BASIS. `liquidationQualities: ['index', 'mid']`.
 * One print moves `last`, and on a thin book that print is cheap to buy. A
 * market with no two-sided quote therefore cannot be liquidated at all — the
 * position sits and an operator looks at it. "An illiquid book is exactly where
 * a forced sale does most damage."
 *
 * A MISSING MARK IS NOT A ZERO MARK. There is no branch here that turns an
 * absent quote into `0`. The caller refuses to value rather than valuing at
 * nothing — and on a perp that matters more than on a loan, because valuing a
 * missing mark at zero does not under-collateralise one borrower, it liquidates
 * everyone at once.
 *
 * The deviation breaker is integer-only and rounds UP, so a move exactly on the
 * breaker trips it. No floats in this path, ever.
 */
import { formatAmount, type Amount } from '@intafaced/ledger-client';

/** How the mark was derived. The liquidation gate cares which. */
export type MarkQuality =
  /** Mid of a two-sided quote. The best this platform can currently produce. */
  | 'mid'
  /** Last trade. One print moves it. */
  | 'last'
  /** A real index feed. Nothing produces this yet; the branch exists so the adapter has somewhere to land. */
  | 'index';

/** Physical feed that produced a mark shown on the public futures strip. */
export type FuturesMarkProvenance = 'depth' | 'venue';

/**
 * A mark for one market, carrying everything the gates need to judge it.
 *
 * `price` is a scaled bigint (Doctrine §0.4 — money is never a `number`), and
 * `asOf` is when the quote was OBSERVED, not when it was read. A source that
 * stamps read-time defeats every staleness check below.
 */
export interface FuturesQuotedMark {
  readonly marketId: string;
  readonly symbol?: string;
  readonly price: Amount;
  readonly asOf: Date;
  readonly quality: MarkQuality;
  /** Optional for generic/test sources; production depth and venue sources always label it. */
  readonly provenance?: FuturesMarkProvenance;
}

export interface MarkPolicy {
  /** Older than this and the mark is not a price, it is a memory. */
  readonly maxAgeSeconds: number;
  /**
   * Additional staleness slack for a MARGIN CALL versus a liquidation.
   * Asymmetric on purpose — see the file header.
   */
  readonly liquidationMaxAgeSeconds: number;
  /**
   * A mark that has moved more than this from the previous accepted mark is
   * rejected as a liquidation basis. A circuit breaker, not a price opinion:
   * a real 40% move happens, a printed one happens more often, and a single
   * tick cannot tell them apart. Refusing to liquidate through the breaker
   * costs a genuine crash one interval; liquidating through it costs the book.
   */
  readonly maxDeviationBps: number;
  /** Mark qualities a liquidation may be based on. */
  readonly liquidationQualities: readonly MarkQuality[];
}

/**
 * Compiled stand-ins. They are not an owner publication. `judgeLiquidationMark`
 * refuses when no limits were published rather than filling these in.
 */
export const COMPILED_FUTURES_MARK_FIGURES = {
  maxAgeSeconds: 300,
  liquidationMaxAgeSeconds: 60,
  maxDeviationBps: 2_000,
} as const;

export const DEFAULT_FUTURES_MARK_POLICY: MarkPolicy = {
  maxAgeSeconds: COMPILED_FUTURES_MARK_FIGURES.maxAgeSeconds,
  liquidationMaxAgeSeconds: COMPILED_FUTURES_MARK_FIGURES.liquidationMaxAgeSeconds,
  maxDeviationBps: COMPILED_FUTURES_MARK_FIGURES.maxDeviationBps,
  // `last` is deliberately absent — see the file header.
  liquidationQualities: ['index', 'mid'],
};

/**
 * Limits an owner actually published. Null means none of them were published.
 * Passing the compiled 300 / 60 / 2000 figures is a publication only when the
 * caller built this object from an owner source — the judge never substitutes
 * {@link COMPILED_FUTURES_MARK_FIGURES} for a missing one.
 */
export interface PublishedLiquidationLimits {
  readonly maxAgeSeconds: number;
  readonly liquidationMaxAgeSeconds: number;
  readonly maxDeviationBps: number;
  readonly liquidationQualities?: readonly MarkQuality[];
}

export const LIQUIDATION_LIMIT_UNPUBLISHED =
  'liquidation mark-age or deviation limit is unpublished — compiled maxAgeSeconds 300, liquidationMaxAgeSeconds 60 and maxDeviationBps 2000 are not an owner publication';

/**
 * Judge a mark for liquidation. No published max age (or no published policy
 * at all) refuses. The compiled figures are named in the reason so a reader
 * can see they were not applied.
 */
export function judgeLiquidationMark(
  mark: FuturesQuotedMark,
  previous: Amount | null,
  now: Date,
  published: PublishedLiquidationLimits | null,
): MarkCheck {
  if (published == null) {
    return {
      ok: false,
      code: MARK_UNUSABLE,
      reason: `${mark.marketId}: ${LIQUIDATION_LIMIT_UNPUBLISHED}`,
    };
  }
  return acceptableForLiquidation(mark, previous, now, {
    maxAgeSeconds: published.maxAgeSeconds,
    liquidationMaxAgeSeconds: published.liquidationMaxAgeSeconds,
    maxDeviationBps: published.maxDeviationBps,
    liquidationQualities: published.liquidationQualities ?? ['index', 'mid'],
  });
}

/**
 * Futures' half of `prices.ts`'s refusal vocabulary. Same shape, same meanings,
 * futures' namespace — a client branching on `bank.mark_unusable` is talking to
 * the wrong service.
 */
export const MARK_UNUSABLE = 'trade.mark_unusable';
/** No mark at all for a market that needs one. Never valued at zero. */
export const MARK_MISSING = 'trade.mark_missing';
/** A mark was zero or negative — a broken feed, not a cheap market. */
export const MARK_INVALID = 'trade.mark_invalid';

export type MarkErrorCode = typeof MARK_UNUSABLE | typeof MARK_MISSING | typeof MARK_INVALID;

export interface MarkCheck {
  readonly ok: boolean;
  readonly reason?: string;
  /** Which refusal this is. Present exactly when `ok` is false. */
  readonly code?: MarkErrorCode;
}

const OK: MarkCheck = { ok: true };

/** Is this mark fit to VALUE a position on — a margin-call notice, a quote, a screen? */
export function acceptableForMarking(mark: FuturesQuotedMark, now: Date, policy: MarkPolicy): MarkCheck {
  if (mark.price <= 0n) {
    return { ok: false, code: MARK_INVALID, reason: `${mark.marketId}: non-positive mark ${formatAmount(mark.price)}` };
  }

  const ageSeconds = (now.getTime() - mark.asOf.getTime()) / 1_000;
  if (ageSeconds > policy.maxAgeSeconds) {
    return {
      ok: false,
      code: MARK_UNUSABLE,
      reason: `${mark.marketId}: mark is ${Math.round(ageSeconds)}s old, limit ${policy.maxAgeSeconds}s`,
    };
  }
  if (ageSeconds < -30) {
    // A mark from the future is a clock problem somewhere, and clock problems
    // are how a stale price passes a staleness check.
    return {
      ok: false,
      code: MARK_UNUSABLE,
      reason: `${mark.marketId}: mark is dated ${Math.round(-ageSeconds)}s in the future`,
    };
  }
  return OK;
}

/**
 * Is this mark fit to OPEN a position — to set entry and size the margin lock?
 *
 * `DIRECTION` MVP-1: a position opens against an oracle, and the mark is **not**
 * our own last-trade price. Entry is a money-moving price (it locks margin), so
 * `last` is refused here even though valuation (screens, losing voluntary exits)
 * may still use it under `acceptableForMarking`.
 *
 * Qualities reuse `liquidationQualities` (index/mid by default) — the same
 * oracle-grade set — without the tighter liquidation staleness or the deviation
 * breaker (there is no previous mark at open).
 */
export function acceptableForEntry(mark: FuturesQuotedMark, now: Date, policy: MarkPolicy): MarkCheck {
  const base = acceptableForMarking(mark, now, policy);
  if (!base.ok) return base;

  if (!policy.liquidationQualities.includes(mark.quality)) {
    return {
      ok: false,
      code: MARK_UNUSABLE,
      reason:
        `${mark.marketId}: mark quality "${mark.quality}" is not an entry basis (allowed: ` +
        `${policy.liquidationQualities.join(', ')}) — DIRECTION MVP-1: a position must not open on last-trade`,
    };
  }
  return OK;
}

/**
 * Is this mark fit to CLOSE A POSITION THE OWNER DID NOT ASK TO CLOSE? A strictly higher bar.
 *
 * `previous` is the last mark this position was accepted against. Passing null
 * skips the deviation breaker — correct for a position's first mark, and safe
 * because the liquidation path also requires the position to be underwater on
 * that same mark before anything is seized.
 */
export function acceptableForLiquidation(mark: FuturesQuotedMark, previous: Amount | null, now: Date, policy: MarkPolicy): MarkCheck {
  const base = acceptableForMarking(mark, now, policy);
  if (!base.ok) return base;

  if (!policy.liquidationQualities.includes(mark.quality)) {
    return {
      ok: false,
      code: MARK_UNUSABLE,
      reason:
        `${mark.marketId}: mark quality "${mark.quality}" is not a liquidation basis (allowed: ` +
        `${policy.liquidationQualities.join(', ')}) — a single print must not close someone's position`,
    };
  }

  const ageSeconds = (now.getTime() - mark.asOf.getTime()) / 1_000;
  if (ageSeconds > policy.liquidationMaxAgeSeconds) {
    return {
      ok: false,
      code: MARK_UNUSABLE,
      reason: `${mark.marketId}: mark is ${Math.round(ageSeconds)}s old, liquidation limit ${policy.liquidationMaxAgeSeconds}s`,
    };
  }

  if (previous !== null && previous > 0n) {
    const delta = mark.price > previous ? mark.price - previous : previous - mark.price;
    // Integer bps, no floats: (delta * 10000) / previous, rounded up so a move
    // exactly on the breaker trips it.
    const deviationBps = Number((delta * 10_000n + previous - 1n) / previous);
    if (deviationBps > policy.maxDeviationBps) {
      return {
        ok: false,
        code: MARK_UNUSABLE,
        reason:
          `${mark.marketId}: mark moved ${deviationBps}bps from ${formatAmount(previous)} to ${formatAmount(mark.price)}, ` +
          `breaker at ${policy.maxDeviationBps}bps — not liquidating through it`,
      };
    }
  }

  return OK;
}

/**
 * The refusal for "there is no mark", spelled once so every caller says the
 * same thing. There is deliberately no `orZero` counterpart.
 */
export function markMissing(marketId: string): MarkCheck {
  return {
    ok: false,
    code: MARK_MISSING,
    reason: `${marketId}: no mark available — refusing to value the position rather than valuing it at nothing`,
  };
}
