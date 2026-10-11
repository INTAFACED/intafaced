import { abs, div, formatAmount, mul, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';

/**
 * CROSS-CHECKING — §27's "cross-checked" market data.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SINGLE VENUE DISAGREEING WITH EVERY OTHER IS A SIGNAL, NOT A PRICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sequence checks catch a book that stopped matching the venue's. They cannot
 * catch a book that matches a venue which is itself wrong — a halted market
 * still quoting its last state, a thin venue whose top has been swept and not
 * refilled, a feed a minute behind its own exchange, an outright bad tick.
 *
 * All of those produce a perfectly-formed, perfectly-sequenced, perfectly-fresh
 * book at a price that is not the market. The only thing that catches them is
 * the other venues.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MEDIAN, NOT MEAN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The mean is defined by the outlier. One venue quoting ten times the market
 * drags the consensus toward itself, and the check ends up flagging the four
 * healthy venues as the ones that have diverged — precisely inverted.
 *
 * The median is unmoved by any minority. That is the whole reason for it, and it
 * is why `minVenues` is three: with two venues the median is their midpoint,
 * both are equidistant from it, and the arithmetic cannot say which one is
 * wrong. It is not that two is a weak check — it is that two is NO check.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FUNCTION MUST NEVER DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It does not pick a price. It does not repair a book. It does not substitute a
 * healthy venue for a diverged one — §27's honesty rule is that a bad venue is
 * EXCLUDED AND REPORTED, and silently swapping in another venue's price under
 * the first one's name is the exact failure the rule exists to forbid.
 *
 * It returns a verdict. The caller excludes, reports, and quotes from what is
 * left — or refuses to quote, which is also a valid outcome.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MIDS, NOT LAST-TRADED PRICES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The comparison is on mid — `(bestBid + bestAsk) / 2`. Deliberately not the
 * last print: a stale last-trade on a thin venue is the single most misleading
 * number in market data, because it is a REAL trade from a market that has since
 * moved, and it will pass every freshness check we have.
 */

export interface VenueMid {
  readonly venueId: string;
  /** `(bestBid + bestAsk) / 2` — see the header. */
  readonly mid: Amount;
  /** When THIS PROCESS read the book the mid came from. */
  readonly observedAt: Date;
}

export interface VenueDeviation {
  readonly venueId: string;
  readonly mid: Amount;
  /** Absolute distance from the consensus, in bps. Never negative. */
  readonly deviationBps: number;
  /** Which side of the consensus. Useful for spotting a whole feed lagging. */
  readonly direction: 'above' | 'below' | 'at';
}

export interface CrossCheckOptions {
  /** Distance from the median beyond which a venue is diverged. Default 50 bps. */
  readonly toleranceBps?: number;
  /** Fewer than this and there is no consensus to check against. Default 3; see the header. */
  readonly minVenues?: number;
  /** Mids older than this are dropped before the check. Default 5s. */
  readonly maxAgeMs?: number;
  readonly now?: Date;
}

export type CrossCheckVerdict =
  /** Enough fresh venues agreed; `consensusMid` is meaningful. */
  | 'consensus'
  /** Consensus reached, and at least one venue is outside tolerance. */
  | 'divergence-detected'
  /**
   * Fewer than `minVenues` fresh mids. NOT a pass and NOT a failure: the check
   * could not run. A caller that treats this as "consensus" has learned nothing
   * and believes it has.
   */
  | 'inconclusive';

export interface CrossCheckReport {
  readonly symbol: string;
  readonly verdict: CrossCheckVerdict;
  /** `null` when `inconclusive`. Never a fabricated fallback. */
  readonly consensusMid: Amount | null;
  readonly agreeing: readonly VenueDeviation[];
  /** Excluded and reported, exactly as §27 requires. */
  readonly diverged: readonly VenueDeviation[];
  /** Dropped before the check ran, with the reason. */
  readonly excluded: readonly { readonly venueId: string; readonly reason: 'stale' | 'clock_skew' | 'no_mid' }[];
  /** One line, for a log or an operator page. */
  readonly detail: string;
}

const DEFAULTS = { toleranceBps: 50, minVenues: 3, maxAgeMs: 5_000 } as const;

export function crossCheckMids(symbol: string, observations: readonly VenueMid[], options: CrossCheckOptions = {}): CrossCheckReport {
  const opts = { ...DEFAULTS, ...options };
  const now = opts.now ?? new Date();
  // minVenues 0 skips `fresh.length < minVenues`; median([]) is 0 — 0 is a price.
  const minVenues = opts.minVenues > 0 ? opts.minVenues : DEFAULTS.minVenues;

  const excluded: { venueId: string; reason: 'stale' | 'clock_skew' | 'no_mid' }[] = [];
  const fresh: VenueMid[] = [];

  for (const observation of observations) {
    if (observation.mid <= ZERO) {
      excluded.push({ venueId: observation.venueId, reason: 'no_mid' });
      continue;
    }
    const age = now.getTime() - observation.observedAt.getTime();
    // NaN fails both comparisons below, so a broken timestamp would look fresh
    // and could set consensusMid. An invalid `now` makes every age non-finite.
    if (!Number.isFinite(age)) {
      excluded.push({ venueId: observation.venueId, reason: 'clock_skew' });
      continue;
    }
    // A mid dated in the FUTURE is a broken clock, not freshness. Reading a
    // negative age as "very fresh" is the one condition under which the
    // staleness ceiling silently stops working.
    if (age < 0) {
      excluded.push({ venueId: observation.venueId, reason: 'clock_skew' });
      continue;
    }
    if (age > opts.maxAgeMs) {
      excluded.push({ venueId: observation.venueId, reason: 'stale' });
      continue;
    }
    fresh.push(observation);
  }

  if (fresh.length === 0 || fresh.length < minVenues) {
    return {
      symbol,
      verdict: 'inconclusive',
      consensusMid: null,
      agreeing: [],
      diverged: [],
      excluded,
      detail: `${fresh.length} fresh venue(s) for ${symbol}, ${minVenues} needed — ` + 'no consensus to check against; this is not a pass',
    };
  }

  const consensusMid = median(fresh.map((observation) => observation.mid));

  const agreeing: VenueDeviation[] = [];
  const diverged: VenueDeviation[] = [];

  for (const observation of fresh) {
    const deviationBps = deviationInBps(observation.mid, consensusMid);
    const entry: VenueDeviation = {
      venueId: observation.venueId,
      mid: observation.mid,
      deviationBps,
      direction: observation.mid > consensusMid ? 'above' : observation.mid < consensusMid ? 'below' : 'at',
    };
    (deviationBps > opts.toleranceBps ? diverged : agreeing).push(entry);
  }

  return {
    symbol,
    verdict: diverged.length > 0 ? 'divergence-detected' : 'consensus',
    consensusMid,
    agreeing,
    diverged,
    excluded,
    detail:
      diverged.length > 0
        ? `${symbol} consensus ${formatAmount(consensusMid)} across ${agreeing.length} venue(s); diverged: ` +
          diverged.map((d) => `${d.venueId} ${formatAmount(d.mid)} (${d.deviationBps}bps ${d.direction})`).join(', ')
        : `${symbol} consensus ${formatAmount(consensusMid)} across ${agreeing.length} venue(s), all within ` + `${opts.toleranceBps}bps`,
  };
}

/**
 * Median of an unsorted list of amounts.
 *
 * On an even count this averages the two middles, which can land between two
 * real venue prices. That is correct for a reference figure and would be wrong
 * for a tradeable one — which is why the report calls it `consensusMid` and
 * nothing in this module hands it to a router as a price.
 */
export function median(values: readonly Amount[]): Amount {
  if (values.length === 0) {
    throw new Error('median of an empty list is not a price — refuse rather than return 0');
  }
  const sorted = [...values].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as Amount;
  return ((sorted[middle - 1] as Amount) + (sorted[middle] as Amount)) / 2n;
}

/** Absolute distance from `reference`, in bps. Integer arithmetic throughout. */
export function deviationInBps(value: Amount, reference: Amount): number {
  if (reference === ZERO) return 0;
  const gap = abs(sub(value, reference));
  // Scale up before dividing so the bps figure keeps its precision, then reduce.
  const scaled = div(mul(gap, 10_000n * 10n ** 18n), abs(reference));
  return Number(scaled / 10n ** 18n);
}
