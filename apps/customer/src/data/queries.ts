/**
 * The hooks' logic without React: each function wires fetchers, the poller and
 * the pure derivations into a `Source<T>` that a screen reads as `Loadable<T>`.
 * `hooks.ts` is the thin React layer over these, so everything here is testable
 * with a fake client and fake timers.
 *
 * Polling cadence (UI-SPEC §4.2): tickers 10 s, balances 30 s, 24 h derivation
 * and sparklines 60 s. Candles for a chart 30 s. Callers may ask for faster.
 */
import type { ApiClient } from '../shared/api';
import { balancesFetcher, marketsFetcher, ohlcvFetcher, tickerFetcher, tickersFetcher } from './fetchers';
import {
  classOf,
  closesOf,
  computeMovers,
  DENSE_SPARKLINE_POINTS,
  DERIVATION_MARKET_CAP,
  derive24h,
  FINE_SPARKLINE,
  forwardFill,
  mergeTicker,
  PAR_ASSETS,
  sparklineFor,
  TIMEFRAME_MS,
  valuePortfolio,
  type BalanceEntry,
  type OhlcvRow,
  type RawTicker,
  serverHas24h,
} from './derive';
import { dec } from './decimal';
import type { Poller } from './poll';
import { blockingState, combine, constantSource, newestAsOf, switchMap, type Source } from './source';
import type { Candle, Decimal, Loadable, MarketRow, Movers, PortfolioSummary, TickerRow, Timeframe } from './types';

export interface DataEnv {
  poller: Poller;
  api: ApiClient;
  /** Scopes private data (balances) so one user's numbers can never show for another. */
  userId: string | null;
  now?: () => number;
}

export interface IntervalOption {
  intervalMs?: number;
}

export const INTERVALS = {
  markets: 300_000,
  tickers: 10_000,
  ticker: 5_000,
  balances: 30_000,
  derivation: 60_000,
  candles: 30_000,
} as const;

const nowOf = (env: DataEnv) => (env.now ?? Date.now)();

/** Derivation reads this many hourly candles per market (24 h plus the one holding the cut). */
const DERIVATION_CANDLES = 25;
const REFUSED_SIGNED_OUT: Loadable<never> = { status: 'refused', code: 'auth.required' };

// ── Sources ─────────────────────────────────────────────────────────────────

/** All spot markets, with `orderable` meaning "can be traded now". */
export function allMarketsSource(env: DataEnv): Source<MarketRow[]> {
  return env.poller.source('markets', marketsFetcher(env.api), { intervalMs: INTERVALS.markets });
}

export function marketsSource(env: DataEnv, options: { includeClosed?: boolean } = {}): Source<MarketRow[]> {
  return combine([allMarketsSource(env)], ([markets]) => {
    if (markets.status !== 'ready') return markets as Loadable<never>;
    const rows = options.includeClosed ? markets.data : markets.data.filter((m) => m.orderable);
    return rows.length === 0 ? { status: 'empty' } : { status: 'ready', data: rows, asOf: markets.asOf };
  });
}

function rawTickersSource(env: DataEnv, intervalMs: number): Source<Record<string, RawTicker>> {
  return env.poller.source('tickers', tickersFetcher(env.api), { intervalMs });
}

function hourlySource(env: DataEnv, symbol: string): Source<OhlcvRow[]> {
  return env.poller.source(`ohlcv:${symbol}:1h:${DERIVATION_CANDLES}`, ohlcvFetcher(env.api, symbol, '1h', DERIVATION_CANDLES), {
    intervalMs: INTERVALS.derivation,
  });
}

/** 15 minute candles for the sparkline of a market whose server sparkline is too short to draw (critic M2). */
function fineSource(env: DataEnv, symbol: string): Source<OhlcvRow[]> {
  const { timeframe, limit } = FINE_SPARKLINE;
  return env.poller.source(`ohlcv:${symbol}:${timeframe}:${limit}`, ohlcvFetcher(env.api, symbol, timeframe, limit), {
    intervalMs: INTERVALS.derivation,
  });
}

const orderableCount = (markets: readonly MarketRow[]) => markets.filter((m) => m.orderable).length;

/** Symbols whose 24 h stats we must derive: derivation allowed (<= 20 orderable markets) and the server did not send them. */
function symbolsToDerive(raw: Readonly<Record<string, RawTicker>>, markets: readonly MarketRow[]): string[] {
  if (orderableCount(markets) > DERIVATION_MARKET_CAP) return [];
  const open = new Set(markets.filter((m) => m.orderable).map((m) => m.symbol));
  return Object.keys(raw)
    .filter((symbol) => open.has(symbol) && !serverHas24h(raw[symbol]!))
    .sort();
}

/** 24 h stats for a set of symbols from their hourly candles. A candle series that failed leaves that symbol without stats. */
function statsFrom(snaps: ReadonlyArray<Loadable<OhlcvRow[]>>, symbols: readonly string[], nowMs: number) {
  const stats = new Map<string, ReturnType<typeof derive24h>>();
  symbols.forEach((symbol, i) => {
    const snap = snaps[i];
    stats.set(symbol, snap && snap.status === 'ready' ? derive24h(snap.data, nowMs) : null);
  });
  return stats;
}

/**
 * Every ticker as a `TickerRow`, with 24 h fields from the server when it sends
 * them and derived from hourly candles otherwise (<= 20 orderable markets).
 * Stays `loading` until the derivation calls have answered, so a percentage
 * never flashes from "—" to a number.
 */
export function tickersSource(env: DataEnv, options: IntervalOption = {}): Source<Record<string, TickerRow>> {
  const raw = rawTickersSource(env, options.intervalMs ?? INTERVALS.tickers);
  return switchMap(
    allMarketsSource(env),
    (markets) => `${orderableCount(markets)}:${markets.map((m) => m.symbol).join(',')}`,
    (markets) =>
      switchMap(
        raw,
        (rawMap) => symbolsToDerive(rawMap, markets).join(','),
        (rawMap) => {
          const symbols = symbolsToDerive(rawMap, markets);
          const candles = symbols.map((symbol) => hourlySource(env, symbol));
          return combine([raw, ...candles] as const, (all) => {
            const [rawSnap, ...candleSnaps] = all as unknown as [Loadable<Record<string, RawTicker>>, ...Loadable<OhlcvRow[]>[]];
            if (rawSnap.status !== 'ready') return rawSnap as Loadable<never>;
            if (candleSnaps.some((s) => s.status === 'loading')) return { status: 'loading' };
            const stats = statsFrom(candleSnaps, symbols, nowOf(env));
            const rows: Record<string, TickerRow> = {};
            for (const [symbol, ticker] of Object.entries(rawSnap.data)) rows[symbol] = mergeTicker(ticker, stats.get(symbol) ?? null);
            return { status: 'ready', data: rows, asOf: newestAsOf(all as unknown as Loadable<unknown>[]) };
          });
        },
      ),
  );
}

/** One market's ticker, polled faster than the list; derives its own 24 h stats whenever the server does not send them. */
export function tickerSource(env: DataEnv, symbol: string, options: IntervalOption = {}): Source<TickerRow> {
  const raw = env.poller.source(`ticker:${symbol}`, tickerFetcher(env.api, symbol), { intervalMs: options.intervalMs ?? INTERVALS.ticker });
  return switchMap(
    raw,
    (ticker) => String(serverHas24h(ticker)),
    (ticker) => {
      const candles = serverHas24h(ticker) ? [] : [hourlySource(env, symbol)];
      return combine([raw, ...candles] as const, (all) => {
        const [rawSnap, candleSnap] = all as unknown as [Loadable<RawTicker>, Loadable<OhlcvRow[]> | undefined];
        if (rawSnap.status !== 'ready') return rawSnap as Loadable<never>;
        if (candleSnap?.status === 'loading') return { status: 'loading' };
        const stats = candleSnap?.status === 'ready' ? derive24h(candleSnap.data, nowOf(env)) : null;
        return { status: 'ready', data: mergeTicker(rawSnap.data, stats), asOf: newestAsOf(all as unknown as Loadable<unknown>[]) };
      });
    },
  );
}

/** 24 hourly closes per symbol: the server's own array when it sends one, else derived from candles (<= 20 orderable markets). */
export function sparklinesSource(env: DataEnv, symbols: readonly string[]): Source<Record<string, Decimal[]>> {
  const wanted = [...new Set(symbols)];
  if (wanted.length === 0) return constantSource<Record<string, Decimal[]>>({ status: 'empty' });
  const raw = rawTickersSource(env, INTERVALS.derivation);
  const key = wanted.join(',');
  return switchMap(
    allMarketsSource(env),
    (markets) => `${key}|${orderableCount(markets)}`,
    (markets) =>
      switchMap(
        raw,
        (rawMap) => `${needSparkline(rawMap, wanted, markets).join(',')}|${needFineSparkline(rawMap, wanted, markets).join(',')}`,
        (rawMap) => {
          const need = needSparkline(rawMap, wanted, markets);
          const needFine = needFineSparkline(rawMap, wanted, markets);
          const candles = [...need.map((symbol) => hourlySource(env, symbol)), ...needFine.map((symbol) => fineSource(env, symbol))];
          return combine([raw, ...candles] as const, (all) => {
            const [rawSnap, ...candleSnaps] = all as unknown as [Loadable<Record<string, RawTicker>>, ...Loadable<OhlcvRow[]>[]];
            if (rawSnap.status !== 'ready') return rawSnap as Loadable<never>;
            if (candleSnaps.some((s) => s.status === 'loading')) return { status: 'loading' };
            const hourlySnaps = candleSnaps.slice(0, need.length);
            const fineSnaps = candleSnaps.slice(need.length);
            const stats = statsFrom(hourlySnaps, need, nowOf(env));
            const out: Record<string, Decimal[]> = {};
            for (const symbol of wanted) {
              const fineIndex = needFine.indexOf(symbol);
              const fineSnap = fineIndex >= 0 ? fineSnaps[fineIndex] : undefined;
              const fine =
                fineSnap && fineSnap.status === 'ready'
                  ? closesOf(fineSnap.data, TIMEFRAME_MS[FINE_SPARKLINE.timeframe], FINE_SPARKLINE.limit, nowOf(env))
                  : null;
              const points = sparklineFor(rawSnap.data[symbol], stats.get(symbol) ?? null, fine);
              if (points) out[symbol] = points;
            }
            return { status: 'ready', data: out, asOf: newestAsOf(all as unknown as Loadable<unknown>[]) };
          });
        },
      ),
  );
}

function needSparkline(raw: Readonly<Record<string, RawTicker>>, wanted: readonly string[], markets: readonly MarketRow[]): string[] {
  if (orderableCount(markets) > DERIVATION_MARKET_CAP) return [];
  const open = new Set(markets.filter((m) => m.orderable).map((m) => m.symbol));
  return wanted
    .filter((symbol) => open.has(symbol) && symbol in raw && !(raw[symbol]!.sparkline && raw[symbol]!.sparkline!.length >= 2))
    .sort();
}

/** Open markets whose server sparkline has points, but too few to draw a line that looks like a price (critic M2). */
function needFineSparkline(raw: Readonly<Record<string, RawTicker>>, wanted: readonly string[], markets: readonly MarketRow[]): string[] {
  if (orderableCount(markets) > DERIVATION_MARKET_CAP) return [];
  const open = new Set(markets.filter((m) => m.orderable).map((m) => m.symbol));
  return wanted
    .filter((symbol) => {
      const points = raw[symbol]?.sparkline?.length ?? 0;
      return open.has(symbol) && points >= 2 && points < DENSE_SPARKLINE_POINTS;
    })
    .sort();
}

/** Biggest 24 h gainers and losers among open markets, one row per coin. */
export function moversSource(env: DataEnv, limit: number): Source<Movers> {
  return combine([tickersSource(env), allMarketsSource(env)] as const, ([tickers, markets]) => {
    const blocked = blockingState([tickers, markets]);
    if (blocked) return blocked;
    if (tickers.status !== 'ready' || markets.status !== 'ready') return { status: 'loading' };
    const movers = computeMovers(
      tickers.data,
      markets.data.filter((m) => m.orderable),
      limit,
    );
    if (movers.gainers.length === 0 && movers.losers.length === 0) return { status: 'empty' };
    return { status: 'ready', data: movers, asOf: newestAsOf([tickers, markets]) };
  });
}

/** Candles for a chart, one per interval: quiet intervals are forward-filled from the previous close. */
export function candlesSource(
  env: DataEnv,
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  options: IntervalOption = {},
): Source<Candle[]> {
  const rows = env.poller.source(`ohlcv:${symbol}:${timeframe}:${limit}`, ohlcvFetcher(env.api, symbol, timeframe, limit), {
    intervalMs: options.intervalMs ?? INTERVALS.candles,
  });
  const stepMs = TIMEFRAME_MS[timeframe];
  return combine([rows], ([snap]) => {
    if (snap.status !== 'ready') return snap as Loadable<never>;
    const nowMs = nowOf(env);
    const fromMs = Math.floor(nowMs / stepMs) * stepMs - (limit - 1) * stepMs;
    const candles = forwardFill(snap.data, { stepMs, nowMs, fromMs }).slice(-limit);
    return candles.length === 0 ? { status: 'empty' } : { status: 'ready', data: candles, asOf: snap.asOf };
  });
}

function balancesSource(env: DataEnv): Source<Record<string, BalanceEntry>> {
  if (!env.userId) return constantSource(REFUSED_SIGNED_OUT);
  return env.poller.source(`balance:${env.userId}`, balancesFetcher(env.api), { intervalMs: INTERVALS.balances });
}

const heldNonPar = (balances: Readonly<Record<string, BalanceEntry>>) =>
  Object.entries(balances).some(
    ([asset, entry]) => !PAR_ASSETS.has(asset.toUpperCase()) && classOf(asset) === 'crypto' && (dec(entry.total) ?? 0n) > 0n,
  );

/**
 * Est. total value (UI-SPEC §1.2). Balances decide whether prices are needed at
 * all: a wallet of only USDT and USDC needs no market data. When prices are
 * needed and cannot load, the whole summary waits or fails; it never shows a
 * partial total that silently leaves a coin out.
 */
export function portfolioSource(env: DataEnv): Source<PortfolioSummary> {
  const balances = balancesSource(env);
  return switchMap(
    balances,
    (held) => String(heldNonPar(held)),
    (held) => {
      if (!heldNonPar(held)) {
        return combine([balances], ([b]) => {
          if (b.status !== 'ready') return b as Loadable<never>;
          return {
            status: 'ready',
            data: valuePortfolio({ balances: b.data, markets: [], tickers: {}, nowMs: nowOf(env), asOf: b.asOf }),
            asOf: b.asOf,
          };
        });
      }
      return combine([balances, allMarketsSource(env), tickersSource(env)] as const, ([b, markets, tickers]) => {
        const blocked = blockingState([b, markets, tickers]);
        if (blocked) return blocked;
        if (b.status !== 'ready' || markets.status !== 'ready' || tickers.status !== 'ready') return { status: 'loading' };
        const asOf = newestAsOf([b, markets, tickers]);
        return {
          status: 'ready',
          data: valuePortfolio({ balances: b.data, markets: markets.data, tickers: tickers.data, nowMs: nowOf(env), asOf }),
          asOf,
        };
      });
    },
  );
}
