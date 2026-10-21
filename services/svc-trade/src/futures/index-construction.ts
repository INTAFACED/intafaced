/**
 * INDEX CONSTRUCTION (D-instruments-01, derivatives-instruments-pricing-005).
 *
 * A weighted multi-source index with outlier rejection. The pieces:
 *
 *  - `IndexFeed` is the port that supplies per-source quotes. No source is configured on main, so the default feed
 *    answers NotConnected `feed.market` as a typed result. It never answers with a number it did not get.
 *  - `buildIndex` is pure. It takes quotes, the owner's source list (with weights) and the owner's floor and bands,
 *    and returns either an index price or a typed refusal.
 *  - Every owner number is nullable. A blank one refuses with `trade.index_params_unset`. Nothing here supplies a
 *    default band, floor or age.
 *
 * Prices are scaled bigint (`Amount`) in memory and decimal strings on the wire. No outside network client lives
 * here: a real feed is an adapter that implements `IndexFeed` and is wired by the host.
 */
import { formatAmount, type Amount } from '@intafaced/ledger-client';

/** The allowlisted blocker for an outside market feed that is not configured. */
export const NOT_CONNECTED_FEED_MARKET = 'feed.market' as const;

/** Refusal codes of this file. `feed.market` is the NotConnected code, not a service error. */
export const INDEX_PARAMS_UNSET = 'trade.index_params_unset';
export const INDEX_STALE = 'trade.index_stale';
export const INDEX_BELOW_FLOOR = 'trade.index_below_floor';

export type IndexRefusalCode = typeof INDEX_PARAMS_UNSET | typeof INDEX_STALE | typeof INDEX_BELOW_FLOOR;

/** One source in the owner's list. `weight` is a positive integer; the index is the weight-averaged price. */
export interface IndexSourceConfig {
  readonly sourceId: string;
  readonly weight: number;
  readonly enabled: boolean;
}

/** The owner floor and bands. A null field is blank. */
export interface IndexParams {
  /** Floor: the fewest live, in-band sources an index may be built from. */
  readonly minSources: number | null;
  /** Band: a quote farther than this from the median of live quotes is rejected as an outlier. */
  readonly outlierBandBps: number | null;
  /** A quote observed longer ago than this is stale and not used. */
  readonly maxAgeSeconds: number | null;
}

export interface IndexQuote {
  readonly sourceId: string;
  readonly price: Amount;
  readonly observedAt: Date;
}

export type IndexFeedResult =
  | { readonly connected: true; readonly quotes: readonly IndexQuote[] }
  | { readonly connected: false; readonly notConnected: typeof NOT_CONNECTED_FEED_MARKET; readonly message: string };

/** Public venue books, one quote per source. */
export interface IndexFeed {
  read(input: { marketId: string; sourceIds: readonly string[]; at: Date }): Promise<IndexFeedResult>;
}

/** Thrown by callers that cannot continue without a feed. The feed port itself returns a typed result. */
export class NotConnectedError extends Error {
  readonly code: typeof NOT_CONNECTED_FEED_MARKET;

  constructor(code: typeof NOT_CONNECTED_FEED_MARKET = NOT_CONNECTED_FEED_MARKET, message?: string) {
    super(message ?? `${code}: the outside index venue feed is not connected`);
    this.name = 'NotConnectedError';
    this.code = code;
  }
}

/** The feed on main: nothing configured, so every read is NotConnected `feed.market`. */
export function notConnectedIndexFeed(): IndexFeed {
  return {
    async read() {
      return {
        connected: false,
        notConnected: NOT_CONNECTED_FEED_MARKET,
        message: 'feed.market: no outside index venue feed is configured, so no index can be built',
      };
    },
  };
}

export interface IndexRejection {
  readonly sourceId: string;
  readonly reason: 'unknown_source' | 'disabled' | 'stale' | 'non_positive' | 'duplicate' | 'outlier';
}

export type IndexResult =
  | {
      readonly ok: true;
      readonly price: Amount;
      readonly median: Amount;
      readonly used: readonly { sourceId: string; price: Amount; weight: number }[];
      readonly rejected: readonly IndexRejection[];
    }
  | {
      readonly ok: false;
      readonly code: IndexRefusalCode;
      readonly message: string;
      readonly missing?: readonly string[];
      readonly rejected: readonly IndexRejection[];
    };

/** The names of blank index owner numbers, in a stable order. */
export function missingIndexParams(params: IndexParams): string[] {
  const out: string[] = [];
  if (params.minSources == null) out.push('minSources');
  if (params.outlierBandBps == null) out.push('outlierBandBps');
  if (params.maxAgeSeconds == null) out.push('maxAgeSeconds');
  return out;
}

function sortedMedian(sorted: readonly Amount[]): Amount {
  const n = sorted.length;
  const mid = n >> 1;
  if (n % 2 === 1) return sorted[mid]!;
  const sum = sorted[mid - 1]! + sorted[mid]!;
  // Half-up on the sum of two positive prices.
  return (sum + 1n) / 2n;
}

/**
 * Build the index from live quotes.
 *
 * 1. Quotes from sources not in the owner's list, disabled sources, repeats of a source, non-positive prices and
 *    quotes older than `maxAgeSeconds` are dropped, each with a reason.
 * 2. Fewer fresh quotes than `minSources` is `trade.index_stale` when age was what removed them, otherwise
 *    `trade.index_below_floor`.
 * 3. Quotes farther than `outlierBandBps` from the median are dropped as outliers.
 * 4. Fewer in-band quotes than `minSources` is `trade.index_below_floor`.
 * 5. The index is the weight-averaged price of what is left, rounded half-up at 18 decimals.
 */
export function buildIndex(input: {
  readonly quotes: readonly IndexQuote[];
  readonly sources: readonly IndexSourceConfig[];
  readonly params: IndexParams;
  readonly at: Date;
}): IndexResult {
  const missing = missingIndexParams(input.params);
  if (missing.length > 0) {
    return {
      ok: false,
      code: INDEX_PARAMS_UNSET,
      message: `${INDEX_PARAMS_UNSET}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} blank, so no index is built`,
      missing,
      rejected: [],
    };
  }
  const minSources = input.params.minSources!;
  const bandBps = BigInt(input.params.outlierBandBps!);
  const maxAgeMs = input.params.maxAgeSeconds! * 1000;

  const config = new Map(input.sources.map((s) => [s.sourceId, s]));
  const rejected: IndexRejection[] = [];
  const seen = new Set<string>();
  const fresh: { sourceId: string; price: Amount; weight: number }[] = [];
  let ageRejected = 0;
  for (const quote of input.quotes) {
    const source = config.get(quote.sourceId);
    if (!source) {
      rejected.push({ sourceId: quote.sourceId, reason: 'unknown_source' });
      continue;
    }
    if (!source.enabled) {
      rejected.push({ sourceId: quote.sourceId, reason: 'disabled' });
      continue;
    }
    if (seen.has(quote.sourceId)) {
      rejected.push({ sourceId: quote.sourceId, reason: 'duplicate' });
      continue;
    }
    seen.add(quote.sourceId);
    if (quote.price <= 0n) {
      rejected.push({ sourceId: quote.sourceId, reason: 'non_positive' });
      continue;
    }
    const ageMs = input.at.getTime() - quote.observedAt.getTime();
    // A quote from the future is a clock fault, and a clock fault is how a stale price passes an age check.
    if (!Number.isFinite(ageMs) || ageMs > maxAgeMs || ageMs < -30_000) {
      rejected.push({ sourceId: quote.sourceId, reason: 'stale' });
      ageRejected += 1;
      continue;
    }
    fresh.push({ sourceId: quote.sourceId, price: quote.price, weight: source.weight });
  }

  if (fresh.length < minSources) {
    const byAge = ageRejected > 0 || fresh.length === 0;
    return {
      ok: false,
      code: byAge ? INDEX_STALE : INDEX_BELOW_FLOOR,
      message: byAge
        ? `${INDEX_STALE}: ${fresh.length} fresh source(s), floor ${minSources}`
        : `${INDEX_BELOW_FLOOR}: ${fresh.length} source(s), floor ${minSources}`,
      rejected,
    };
  }

  const median = sortedMedian(fresh.map((q) => q.price).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  const used: { sourceId: string; price: Amount; weight: number }[] = [];
  for (const q of fresh) {
    const delta = q.price > median ? q.price - median : median - q.price;
    // Integer test, no division: delta/median > band/10000.
    if (delta * 10_000n > bandBps * median) rejected.push({ sourceId: q.sourceId, reason: 'outlier' });
    else used.push(q);
  }
  if (used.length < minSources) {
    return {
      ok: false,
      code: INDEX_BELOW_FLOOR,
      message: `${INDEX_BELOW_FLOOR}: ${used.length} in-band source(s) after outlier rejection, floor ${minSources}`,
      rejected,
    };
  }

  let weighted = 0n;
  let totalWeight = 0n;
  for (const q of used) {
    weighted += q.price * BigInt(q.weight);
    totalWeight += BigInt(q.weight);
  }
  const price = (weighted * 2n + totalWeight) / (totalWeight * 2n);
  return { ok: true, price, median, used, rejected };
}

/** Wire form of a built index, for the desk. */
export function presentIndex(result: IndexResult): Record<string, unknown> {
  if (!result.ok) return { ok: false, code: result.code, message: result.message, rejected: result.rejected };
  return {
    ok: true,
    price: formatAmount(result.price),
    median: formatAmount(result.median),
    used: result.used.map((u) => ({ sourceId: u.sourceId, price: formatAmount(u.price), weight: u.weight })),
    rejected: result.rejected,
  };
}
