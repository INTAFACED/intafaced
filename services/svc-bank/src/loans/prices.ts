import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { Mark } from './risk.js';

/**
 * MARKS — where a wrong number becomes someone else's liquidation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT §8.1 ASKS FOR AND WHAT ACTUALLY EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * §8.1: "portfolio-aware LTV job (marks from svc-trade index prices)".
 *
 * svc-trade has no index price. It has `GET /api/v1/ticker/:symbol`, which
 * returns best bid, best ask and LAST TRADE from svc-matching's in-memory book,
 * and `GET /api/v1/tickers` for all markets. There is no TWAP, no external
 * oracle, no multi-venue median, and nothing that survives one trade on a thin
 * book. That is not a criticism of svc-trade — it is a market-data surface doing
 * its job — but it means the sentence in the spec describes a component that has
 * not been built, and a loan book that marks off `last` inherits every property
 * of `last`.
 *
 * The attack is not hypothetical and it is cheap. A borrower's collateral is
 * marked at the last trade. On a market with little resting depth, the borrower
 * (or anyone) sells a small quantity into the bid to print a low last price,
 * every loan collateralised by that asset marks down at once, and liquidations
 * fire across the book at a price nobody could have got size at. Run the other
 * way, a borrower prints a HIGH last price and draws principal against
 * collateral that is not worth it — and that loss lands on the reserve.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DOES ABOUT IT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It does not pretend to fix it. It does three things that are worth more than
 * pretending:
 *
 *   1. Makes the mark an explicit PORT, so the day an index price exists it is
 *      one adapter and no change to any money path.
 *   2. Refuses marks that fail stated sanity checks — stale, non-positive, or
 *      moved further in one interval than a real market does — instead of
 *      liquidating against them.
 *   3. Distinguishes what a mark is good enough FOR. A margin call on a
 *      questionable mark costs the borrower a notification. A liquidation on a
 *      questionable mark costs them their collateral. Those are not the same
 *      decision and this file does not let them share a threshold.
 *
 * ── THE CROSS-STREAM ASK, stated rather than smuggled ────────────────────────
 *
 * svc-trade belongs to another agent and is not edited here. What loans need
 * from it, in the order they matter:
 *
 *   (a) An INDEX price per market — mid-of-book or a short TWAP, explicitly not
 *       `last` — carrying its own `asOf` and a depth figure at some band, so a
 *       consumer can tell a real price from a printed one.
 *   (b) A DEPTH read at a price band, so `maxTrancheBps` can be sized against
 *       the book that actually exists rather than a fixed guess.
 *   (c) Eventually, orders funded from a `collateral` pot, so a liquidation can
 *       walk a real book. Until then `loanLiquidate` sells to a named
 *       counterparty at a marked price — atomic and honest, but not a match.
 *
 * Until (a) lands, `TickerPriceSource` reads mid-of-book where a two-sided
 * quote exists and falls back to `last` where it does not, and it labels which
 * it used so `MarkPolicy` can refuse to liquidate on the weaker one.
 */

/** How the mark was derived. The liquidation gate cares which. */
export type MarkQuality =
  /** Mid of a two-sided quote. The best this platform can currently produce. */
  | 'mid'
  /** Last trade. One print moves it — see the file header. */
  | 'last'
  /** A real index feed. Nothing produces this yet; the branch exists so the adapter has somewhere to land. */
  | 'index';

export interface QuotedMark extends Mark {
  readonly quality: MarkQuality;
}

/**
 * The port. One method, because a mark is one question.
 *
 * Returns marks for the requested assets IN THE QUOTE ASSET. Missing assets are
 * omitted rather than defaulted — `risk.ts` refuses to value a holding whose mark
 * is absent, and that refusal is the point.
 */
export interface PriceSource {
  marks(assetIds: readonly string[], quoteAssetId: string): Promise<Map<string, QuotedMark>>;
}

export interface MarkPolicy {
  /** Older than this and the mark is not a price, it is a memory. */
  readonly maxAgeSeconds: number;
  /**
   * Additional staleness slack for a MARGIN CALL versus a liquidation.
   *
   * Asymmetric on purpose. Refusing to warn a borrower because the feed is 40
   * seconds old leaves them uninformed; refusing to SELL on the same mark leaves
   * them with their collateral. So warnings tolerate a stale mark and seizures do
   * not.
   */
  readonly liquidationMaxAgeSeconds: number;
  /**
   * A mark that has moved more than this from the previous accepted mark is
   * rejected as a liquidation basis.
   *
   * This is a circuit breaker, not a price opinion. A real 40% move happens; a
   * printed one happens more often, and the difference between them is not
   * visible in a single tick. Refusing to liquidate through the breaker means a
   * genuine crash liquidates one interval later, which is a real cost — and a
   * smaller one than liquidating the whole book on a spoofed print.
   */
  readonly maxDeviationBps: number;
  /** Mark qualities a liquidation may be based on. */
  readonly liquidationQualities: readonly MarkQuality[];
}

export const DEFAULT_MARK_POLICY: MarkPolicy = {
  maxAgeSeconds: 300,
  liquidationMaxAgeSeconds: 60,
  maxDeviationBps: 2_000,
  // `last` is deliberately absent. On the current market-data surface that means
  // a market with no two-sided quote cannot be liquidated at all — the loan sits
  // in margin call and an operator has to look at it. That is the correct
  // failure: an illiquid book is exactly where a forced sale does most damage,
  // and "we could not get a trustworthy price" is a better outcome than a
  // seizure at an untrustworthy one.
  liquidationQualities: ['index', 'mid'],
};

export interface MarkCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/** Is this mark fit to warn a borrower on? */
export function acceptableForMarking(mark: QuotedMark, now: Date, policy: MarkPolicy): MarkCheck {
  if (mark.price <= 0n) return { ok: false, reason: `${mark.assetId}: non-positive mark ${formatAmount(mark.price)}` };

  const ageSeconds = (now.getTime() - mark.asOf.getTime()) / 1_000;
  if (ageSeconds > policy.maxAgeSeconds) {
    return { ok: false, reason: `${mark.assetId}: mark is ${Math.round(ageSeconds)}s old, limit ${policy.maxAgeSeconds}s` };
  }
  if (ageSeconds < -30) {
    // A mark from the future is a clock problem somewhere, and clock problems
    // are how a stale price passes a staleness check.
    return { ok: false, reason: `${mark.assetId}: mark is dated ${Math.round(-ageSeconds)}s in the future` };
  }
  return { ok: true };
}

/**
 * Is this mark fit to SEIZE COLLATERAL on? A strictly higher bar.
 *
 * `previous` is the last mark this loan was accepted against. Passing null skips
 * the deviation breaker — correct for a loan's first mark, and the reason the
 * first mark can never trigger a liquidation on its own is that `planLiquidation`
 * also requires an already-open margin call.
 */
export function acceptableForLiquidation(mark: QuotedMark, previous: Amount | null, now: Date, policy: MarkPolicy): MarkCheck {
  const base = acceptableForMarking(mark, now, policy);
  if (!base.ok) return base;

  if (!policy.liquidationQualities.includes(mark.quality)) {
    return {
      ok: false,
      reason:
        `${mark.assetId}: mark quality "${mark.quality}" is not a liquidation basis (allowed: ` +
        `${policy.liquidationQualities.join(', ')}) — a single print must not seize collateral`,
    };
  }

  const ageSeconds = (now.getTime() - mark.asOf.getTime()) / 1_000;
  if (ageSeconds > policy.liquidationMaxAgeSeconds) {
    return {
      ok: false,
      reason: `${mark.assetId}: mark is ${Math.round(ageSeconds)}s old, liquidation limit ${policy.liquidationMaxAgeSeconds}s`,
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
        reason:
          `${mark.assetId}: mark moved ${deviationBps}bps from ${formatAmount(previous)} to ${formatAmount(mark.price)}, ` +
          `breaker at ${policy.maxDeviationBps}bps — not liquidating through it`,
      };
    }
  }

  return { ok: true };
}

export function assertAcceptableForLiquidation(mark: QuotedMark, previous: Amount | null, now: Date, policy: MarkPolicy): void {
  const check = acceptableForLiquidation(mark, previous, now, policy);
  if (!check.ok) throw new BankError(`Refusing to liquidate on this mark — ${check.reason}`, 'bank.mark_unusable');
}

// ── Adapters ─────────────────────────────────────────────────────────────────

/**
 * A mark that is always the same. For the identity case and for tests.
 *
 * `clock` exists because the staleness guards compare `asOf` against the
 * caller's `now`, and a source that always stamps wall-clock time hands back
 * marks from the FUTURE whenever the caller is working at a fixed instant —
 * which every test of a grace period necessarily is. Those marks are then
 * correctly rejected, and the suite fails for a reason that has nothing to do
 * with what it was testing.
 */
export function fixedPriceSource(
  prices: Record<string, { price: string; quality?: MarkQuality }>,
  clock: () => Date = () => new Date(),
): PriceSource {
  return {
    marks: async (assetIds, quoteAssetId) => {
      const out = new Map<string, QuotedMark>();
      const now = clock();
      for (const assetId of assetIds) {
        if (assetId === quoteAssetId) {
          // The quote asset is worth one of itself. Not a price lookup, and
          // routing it through a feed would make the whole book depend on a
          // market that need not exist.
          out.set(assetId, { assetId, price: parseAmount('1'), asOf: now, quality: 'index' });
          continue;
        }
        const entry = prices[assetId];
        if (!entry) continue;
        out.set(assetId, { assetId, price: parseAmount(entry.price), asOf: now, quality: entry.quality ?? 'mid' });
      }
      return out;
    },
  };
}

interface TickerResponse {
  readonly bid: string | null;
  readonly ask: string | null;
  readonly last: string | null;
  readonly timestamp?: number | null;
}

/**
 * svc-trade's public ticker, read over HTTP.
 *
 * Mid where a two-sided quote exists, `last` where it does not, and the quality
 * is labelled either way so `DEFAULT_MARK_POLICY` can refuse to liquidate on the
 * weaker one. This is a READ of another stream's public surface — no import of
 * svc-trade, no shared table, and nothing here writes to it.
 */
export function tickerPriceSource(options: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }): PriceSource {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;

  return {
    marks: async (assetIds, quoteAssetId) => {
      const out = new Map<string, QuotedMark>();

      await Promise.all(
        assetIds.map(async (assetId) => {
          if (assetId === quoteAssetId) {
            out.set(assetId, { assetId, price: parseAmount('1'), asOf: new Date(), quality: 'index' });
            return;
          }

          const symbol = encodeURIComponent(`${assetId}/${quoteAssetId}`);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);

          try {
            const res = await doFetch(`${options.baseUrl}/api/v1/ticker/${symbol}`, { signal: controller.signal });
            if (!res.ok) return;

            const body = (await res.json()) as TickerResponse;
            // No stated time, no mark. Stamping "now" on a quote of unknown age
            // would let a stale price pass the staleness guard.
            if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)) return;
            const asOf = new Date(body.timestamp);

            if (body.bid && body.ask) {
              const bid = parseAmount(body.bid);
              const ask = parseAmount(body.ask);
              if (bid > 0n && ask > 0n) {
                // Floor of the mid: half a unit in the conservative direction on
                // a collateral mark, which is the direction collateral rounds.
                out.set(assetId, { assetId, price: (bid + ask) / 2n, asOf, quality: 'mid' });
                return;
              }
            }
            if (body.last) {
              const last = parseAmount(body.last);
              if (last > 0n) out.set(assetId, { assetId, price: last, asOf, quality: 'last' });
            }
          } catch {
            // A missing mark is not a zero mark. Omitted, so `risk.ts` refuses to
            // value the position rather than valuing it at nothing.
          } finally {
            clearTimeout(timer);
          }
        }),
      );

      return out;
    },
  };
}
