/**
 * Pure derivations (UI-SPEC §4.2): forward-filled candles, 24 h stats, total
 * value, movers. No I/O and no React; every money step is scaled-bigint
 * arithmetic from `decimal.ts`. A value that cannot be known is `null`.
 *
 * These stand in until the backend unlocks land (U1 server 24 h fields, U3
 * server valuation, U4 asset class). Each derived row says `source: 'derived'`.
 * Wherever the server already sends a field, that field wins (`mergeTicker`).
 */
import { fiat } from '@intafaced/i18n';
import { dec, decOrNull, maxOf, minOf, ratio, str, sub, sumOf, times, ZERO, type Scaled } from './decimal';
import type { Candle, Decimal, Holding, MarketRow, PortfolioSummary, Movers, TickerRow, Timeframe } from './types';

/** `[openTimeMs, open, high, low, close, volume]` as the OHLCV endpoint returns it. */
export type OhlcvRow = readonly [number, string, string, string, string, string];

/** What `/tickers` and `/ticker/{symbol}` send (CCXT shape). U1 fills the nulls and adds `sparkline`. */
export interface RawTicker {
  symbol: string;
  timestamp: number;
  last: string | null;
  bid: string | null;
  ask: string | null;
  open: string | null;
  high: string | null;
  low: string | null;
  change: string | null;
  /** CCXT sends percent (2.5 means 2.5%); we only use it when open/change are missing. */
  percentage: string | null;
  baseVolume: string | null;
  quoteVolume: string | null;
  sparkline?: readonly string[] | null;
  /** Epoch ms the server's 24 h figures start at. Earlier than now - 24 h is a full day; later is a market younger than that. */
  windowStart?: number | null;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': HOUR_MS,
  '4h': 4 * HOUR_MS,
  '1d': DAY_MS,
};

/** Above this many orderable markets the client stops deriving 24 h stats (one request per market is too dear). */
export const DERIVATION_MARKET_CAP = 20;

const bucketStart = (t: number, stepMs: number) => t - (((t % stepMs) + stepMs) % stepMs);

// ── Candles ──────────────────────────────────────────────────────────────────

export interface ForwardFillOptions {
  stepMs: number;
  nowMs: number;
  /** Emit candles from the bucket containing this time (earlier real candles only seed the carry). */
  fromMs?: number;
  /** Safety bound on how many buckets are produced. Default 5000. */
  maxBuckets?: number;
}

/**
 * The OHLCV endpoint builds candles from fills, so a silent interval has no
 * candle at all. Charts need one per interval: a silent bucket becomes a flat
 * candle at the previous close with volume 0, marked `filled`. The series runs
 * up to the current bucket.
 */
export function forwardFill(rows: readonly OhlcvRow[], options: ForwardFillOptions): Candle[] {
  const { stepMs, nowMs } = options;
  const maxBuckets = options.maxBuckets ?? 5000;
  const byBucket = new Map<number, Candle>();
  for (const row of rows) {
    const t = bucketStart(row[0], stepMs);
    byBucket.set(t, { t, o: row[1], h: row[2], l: row[3], c: row[4], v: row[5], filled: false });
  }
  if (byBucket.size === 0) return [];
  const bucketTimes = [...byBucket.keys()].sort((a, b) => a - b);
  const firstT = bucketTimes[0]!;
  const lastT = bucketTimes[bucketTimes.length - 1]!;
  const endT = Math.max(bucketStart(nowMs, stepMs), lastT);
  const startT = Math.max(
    firstT,
    options.fromMs === undefined ? firstT : bucketStart(options.fromMs, stepMs),
    endT - (maxBuckets - 1) * stepMs,
  );

  let carry: string | null = null;
  for (const t of bucketTimes) {
    if (t >= startT) break;
    carry = byBucket.get(t)!.c;
  }
  const out: Candle[] = [];
  for (let t = startT; t <= endT; t += stepMs) {
    const real = byBucket.get(t);
    if (real) {
      out.push(real);
      carry = real.c;
    } else if (carry !== null) {
      out.push({ t, o: carry, h: carry, l: carry, c: carry, v: '0', filled: true });
    }
  }
  return out;
}

// ── 24 h stats ───────────────────────────────────────────────────────────────

export interface Stats24h {
  open24h: Decimal;
  high24h: Decimal | null;
  low24h: Decimal | null;
  baseVolume24h: Decimal | null;
  /** Epoch ms. At or before now - 24 h means a full window; later means the market is younger than a day. */
  windowStart: number;
  /** Closes of the last 24 hourly candles, oldest first. */
  sparkline: Decimal[];
}

/**
 * 24 h stats from the last 25 hourly candles (UI-SPEC §4.2):
 * `open24h` is the open of the first candle at or after now - 24 h; high, low and
 * base volume come from the candles in that window. A market younger than a day
 * reports its first candle as `windowStart` so the screen can say "since 14:00".
 * Quote volume is not derivable (candles carry none).
 */
export function derive24h(rows: readonly OhlcvRow[], nowMs: number): Stats24h | null {
  if (rows.length === 0) return null;
  const cutoff = nowMs - DAY_MS;
  const filled = forwardFill(rows, { stepMs: HOUR_MS, nowMs, fromMs: cutoff });
  const window = filled.filter((c) => c.t >= cutoff);
  const first = window[0];
  if (!first) return null;
  const firstRealT = Math.min(...rows.map((r) => bucketStart(r[0], HOUR_MS)));
  const full = firstRealT <= cutoff;

  const highs = window.map((c) => dec(c.h));
  const lows = window.map((c) => dec(c.l));
  const volumes = window.map((c) => dec(c.v));
  const allKnown = <T>(values: readonly (T | null)[]): values is readonly T[] => values.every((v) => v !== null);

  return {
    open24h: first.o,
    high24h: allKnown(highs) ? decOrNull(maxOf(highs)) : null,
    low24h: allKnown(lows) ? decOrNull(minOf(lows)) : null,
    baseVolume24h: allKnown(volumes) ? str(sumOf(volumes)) : null,
    windowStart: full ? cutoff : first.t,
    sparkline: filled.slice(-24).map((c) => c.c),
  };
}

/** Is this server ticker already carrying its own 24 h statistics (U1 landed)? */
export function serverHas24h(raw: RawTicker): boolean {
  return dec(raw.open) !== null || dec(raw.percentage) !== null || dec(raw.change) !== null;
}

/**
 * One row for the screens. Server fields win wherever the server sent them;
 * derived stats fill the rest. Change and percent are recomputed from the
 * merged open and `last`, so they never disagree with the numbers beside them.
 */
export function mergeTicker(raw: RawTicker, stats: Stats24h | null): TickerRow {
  const open = dec(raw.open) !== null ? raw.open : (stats?.open24h ?? null);
  const last = dec(raw.last) !== null ? raw.last : null;

  let change: Decimal | null = dec(raw.change) !== null ? raw.change : null;
  if (change === null) {
    const l = dec(last);
    const o = dec(open);
    change = l !== null && o !== null ? str(sub(l, o)) : null;
  }

  let pct: Decimal | null = null;
  const changeScaled = dec(change);
  const openScaled = dec(open);
  if (changeScaled !== null && openScaled !== null && openScaled > 0n) pct = decOrNull(ratio(changeScaled, openScaled));
  else if (dec(raw.percentage) !== null) pct = decOrNull(ratio(dec(raw.percentage)!, 100n * 10n ** 18n));

  const usedDerived =
    stats !== null && (dec(raw.open) === null || dec(raw.high) === null || dec(raw.low) === null || dec(raw.baseVolume) === null);
  return {
    symbol: raw.symbol,
    last,
    bid: dec(raw.bid) !== null ? raw.bid : null,
    ask: dec(raw.ask) !== null ? raw.ask : null,
    open24h: open,
    high24h: dec(raw.high) !== null ? raw.high : (stats?.high24h ?? null),
    low24h: dec(raw.low) !== null ? raw.low : (stats?.low24h ?? null),
    change24h: change,
    changePct24h: pct,
    baseVolume24h: dec(raw.baseVolume) !== null ? raw.baseVolume : (stats?.baseVolume24h ?? null),
    quoteVolume24h: dec(raw.quoteVolume) !== null ? raw.quoteVolume : null,
    // The server's own window start wins: a market that listed 3 hours ago sends that hour, not a full day.
    windowStart:
      typeof raw.windowStart === 'number'
        ? raw.windowStart
        : dec(raw.open) !== null
          ? raw.timestamp - DAY_MS
          : (stats?.windowStart ?? null),
    source: usedDerived ? 'derived' : 'server',
  };
}

/** A server sparkline shorter than this draws as a crude zig-zag, so finer candles replace it (critic M2). */
export const DENSE_SPARKLINE_POINTS = 12;
/** The finer series that replaces a crude server sparkline: 15 minute candles over the last day. */
export const FINE_SPARKLINE = { timeframe: '15m', limit: 96 } as const;

/**
 * Closes of the last `count` candles of a series, one per interval (a silent interval carries the previous
 * close, it is not interpolated). Oldest first.
 */
export function closesOf(rows: readonly OhlcvRow[], stepMs: number, count: number, nowMs: number): Decimal[] {
  return forwardFill(rows, { stepMs, nowMs, fromMs: nowMs - count * stepMs })
    .slice(-count)
    .map((c) => c.c);
}

/**
 * Sparkline points for a symbol, best first: the server's array when it has enough points to draw a line, the
 * finer candle closes when it does not, then whatever the server sent, then the derived hourly closes.
 */
export function sparklineFor(raw: RawTicker | undefined, stats: Stats24h | null, fine: readonly Decimal[] | null = null): Decimal[] | null {
  const fromServer = raw?.sparkline?.filter((p) => dec(p) !== null) ?? [];
  if (fromServer.length >= DENSE_SPARKLINE_POINTS) return [...fromServer];
  if (fine && fine.length >= 2) return [...fine];
  if (fromServer.length >= 2) return [...fromServer];
  return stats && stats.sparkline.length >= 2 ? stats.sparkline : null;
}

// ── Markets ─────────────────────────────────────────────────────────────────

const PRICE_QUOTES = ['USDT', 'USDC'] as const;

/** Markets to look at for a coin's USD price, best first: its USDT market, then its USDC market. */
export function priceSymbolsFor(asset: string, markets: readonly MarketRow[]): string[] {
  const base = asset.trim().toUpperCase();
  return PRICE_QUOTES.flatMap((quote) =>
    markets
      .filter((m) => m.base === base && m.quote === quote)
      .map((m) => m.symbol)
      .slice(0, 1),
  );
}

/** The market that prices a coin: its USDT market, else its USDC market, else null. */
export function primarySymbolFor(asset: string, markets: readonly MarketRow[]): string | null {
  return priceSymbolsFor(asset, markets)[0] ?? null;
}

/** Assets counted as exactly 1 USD (UI-SPEC §1.2). */
export const PAR_ASSETS: ReadonlySet<string> = new Set(['USDT', 'USDC', 'USD']);

/** `cash` for stablecoins and fiat codes, `crypto` for everything else (until the server sends a class). */
export function classOf(asset: string): 'cash' | 'crypto' {
  const code = asset.trim().toUpperCase();
  return PAR_ASSETS.has(code) || fiat(code) !== undefined ? 'cash' : 'crypto';
}

// ── Movers ───────────────────────────────────────────────────────────────────

/**
 * Biggest 24 h moves among open markets. One row per coin (its USDT market wins
 * over USDC), gainers strictly above zero, losers strictly below.
 */
export function computeMovers(tickers: Readonly<Record<string, TickerRow>>, markets: readonly MarketRow[], limit: number): Movers {
  const best = new Map<string, { row: TickerRow; rank: number; pct: Scaled }>();
  for (const market of markets) {
    const row = tickers[market.symbol];
    const pct = dec(row?.changePct24h);
    if (!row || pct === null) continue;
    const rank = PRICE_QUOTES.indexOf(market.quote as (typeof PRICE_QUOTES)[number]);
    const held = best.get(market.base);
    const mine = rank === -1 ? PRICE_QUOTES.length : rank;
    if (!held || mine < held.rank) best.set(market.base, { row, rank: mine, pct });
  }
  const all = [...best.values()];
  const gainers = all
    .filter((x) => x.pct > ZERO)
    .sort((a, b) => (a.pct === b.pct ? 0 : a.pct > b.pct ? -1 : 1))
    .slice(0, Math.max(0, limit))
    .map((x) => x.row);
  const losers = all
    .filter((x) => x.pct < ZERO)
    .sort((a, b) => (a.pct === b.pct ? 0 : a.pct < b.pct ? -1 : 1))
    .slice(0, Math.max(0, limit))
    .map((x) => x.row);
  return { gainers, losers };
}

// ── Portfolio ────────────────────────────────────────────────────────────────

export interface BalanceEntry {
  free: Decimal;
  used: Decimal;
  total: Decimal;
}

export interface ValuationInput {
  balances: Readonly<Record<string, BalanceEntry>>;
  markets: readonly MarketRow[];
  tickers: Readonly<Record<string, TickerRow>>;
  nowMs: number;
  asOf?: number;
}

/**
 * Est. total value in USD (UI-SPEC §1.2, §4.2).
 *
 * USDT, USDC and USD count as exactly 1 USD. Any other coin is valued at the
 * last price of its USDT market, else its USDC market; a coin with no such price,
 * and any other fiat code (no FX source exists), is listed in `unpriced` and not
 * counted. "Today" is the sum over held coins of amount x (last - open24h); it is
 * `null` when any counted coin's 24 h open is unknown, never a partial sum.
 * Trades and transfers made today are not counted: it is a price-move figure.
 */
export function valuePortfolio(input: ValuationInput): PortfolioSummary {
  const asOf = input.asOf ?? input.nowMs;
  const holdings: Holding[] = [];
  const unpriced: string[] = [];
  const values: Array<{ holding: Holding; value: Scaled; change: Scaled | null; prior: Scaled | null; windowStart: number | null }> = [];

  for (const [asset, entry] of Object.entries(input.balances)) {
    const total = dec(entry.total);
    if (total === null) {
      unpriced.push(asset);
      continue;
    }
    if (total <= 0n) continue;
    const base: Holding = {
      asset,
      class: classOf(asset),
      total: entry.total,
      available: entry.free,
      inOrders: entry.used,
      usdValue: null,
      usdChange24h: null,
      share: null,
      priceSymbol: null,
    };
    if (PAR_ASSETS.has(asset.toUpperCase())) {
      values.push({ holding: { ...base, priceUsd: '1' }, value: total, change: ZERO, prior: total, windowStart: null });
      continue;
    }
    if (base.class === 'cash') {
      // Another fiat currency: there is no FX rate to count it in USD.
      holdings.push(base);
      unpriced.push(asset);
      continue;
    }
    let priced = false;
    for (const symbol of priceSymbolsFor(asset, input.markets)) {
      const ticker = input.tickers[symbol];
      const last = dec(ticker?.last);
      if (last === null || last <= 0n) continue;
      const open = dec(ticker?.open24h);
      const value = times(total, last);
      const change = open === null ? null : times(total, sub(last, open));
      const partial = ticker?.windowStart != null && ticker.windowStart > input.nowMs - DAY_MS ? ticker.windowStart : null;
      values.push({
        holding: { ...base, priceSymbol: symbol, priceUsd: str(last) },
        value,
        change,
        prior: open === null ? null : times(total, open),
        windowStart: partial,
      });
      priced = true;
      break;
    }
    if (!priced) {
      holdings.push(base);
      unpriced.push(asset);
    }
  }

  const totalValue = sumOf(values.map((v) => v.value));
  const counted = values.length > 0;
  const finished: Holding[] = values
    .sort((a, b) => (a.value === b.value ? a.holding.asset.localeCompare(b.holding.asset) : a.value > b.value ? -1 : 1))
    .map((v) => ({
      ...v.holding,
      usdValue: str(v.value),
      usdChange24h: decOrNull(v.change),
      share: totalValue > 0n ? decOrNull(ratio(v.value, totalValue)) : null,
    }));
  holdings.sort((a, b) => a.asset.localeCompare(b.asset));

  const nothingHeld = values.length === 0 && holdings.length === 0 && unpriced.length === 0;
  const knownChange = values.every((v) => v.change !== null && v.prior !== null);
  const change = counted && knownChange ? sumOf(values.map((v) => v.change as Scaled)) : null;
  const prior = counted && knownChange ? sumOf(values.map((v) => v.prior as Scaled)) : null;
  const partialStarts = values.map((v) => v.windowStart).filter((t): t is number => t !== null);

  const cash = values.filter((v) => v.holding.class === 'cash');
  const crypto = values.filter((v) => v.holding.class === 'crypto');

  return {
    totalUsd: counted ? str(totalValue) : nothingHeld ? '0' : null,
    change24hUsd: change !== null ? str(change) : nothingHeld ? '0' : null,
    change24hPct: change !== null && prior !== null ? decOrNull(ratio(change, prior)) : null,
    cashUsd: counted || nothingHeld ? str(sumOf(cash.map((v) => v.value))) : null,
    cryptoUsd: counted || nothingHeld ? str(sumOf(crypto.map((v) => v.value))) : null,
    holdings: [...finished, ...holdings],
    unpriced,
    source: 'derived',
    asOf,
    windowStart: partialStarts.length > 0 ? Math.max(...partialStarts) : null,
  };
}
