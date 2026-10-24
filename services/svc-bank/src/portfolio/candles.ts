import { parseAmount, type Amount } from '@intafaced/ledger-client';
import type { ValueSeriesInterval } from '@intafaced/contracts';
import { PRICE_QUOTES } from './valuation.js';

/**
 * CANDLE SERIES — one coin's closes over a window, from svc-trade's public market data (`/api/v1/ohlcv`), the same public
 * read the Money total's prices come from. Read on the coin's USDT market, else its USDC market (the valuation order).
 *
 * svc-trade answers a window only whole, from `since` to now in at most `POINTS_PER_READ` candles, and leaves out a candle
 * in which nothing traded. So one read covers a series, and a coin that last traded before the window has no candle ended
 * by its start; its last close before the start is read then, from the hours of the day before, else the days of the 30
 * days before (the same price-at-time rule as the Money total's history), and set as a candle ended by the start. A market
 * with no candle at all in the window and none before it is passed over for the next quote, as the Money total does. No
 * candle means no price: a moment is missing, never zero.
 */

export const SERIES_TIMEFRAME_MS: Readonly<Record<ValueSeriesInterval, number>> = {
  '5m': 300_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

/** One market's candles over a window: open time (epoch ms) and close, oldest first. */
export interface CloseSeries {
  readonly market: string;
  readonly candles: ReadonlyArray<readonly [number, Amount]>;
}

export interface CloseSeriesSource {
  /** Null: the coin has neither market. Throws when the market data cannot be read, so nothing is drawn from part of it. */
  closes(assetId: string, interval: ValueSeriesInterval, from: Date, to: Date): Promise<CloseSeries | null>;
}

/** Technical bounds on one market data read, not business values: a timeout, the most points the door returns, and how
 * far back the start's last daily close is looked for. */
const READ_TIMEOUT_MS = 3_000;
const POINTS_PER_READ = 720;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Where the start's last close is looked for: a day of hours, else 30 days of days. */
const START_LOOKBACK: ReadonlyArray<{ timeframe: string; ms: number; back: number }> = [
  { timeframe: '1h', ms: HOUR_MS, back: 24 },
  { timeframe: '1d', ms: DAY_MS, back: 30 },
];

type Rows = Array<[number, string]>;

export function httpCloseSeries(options: { baseUrl: string; fetchImpl?: typeof fetch; now?: () => Date }): CloseSeriesSource {
  const base = options.baseUrl.replace(/\/$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  const candles = async (market: string, timeframe: string, since: number): Promise<Rows | 'no_market' | 'too_far'> => {
    const url = `${base}/api/v1/ohlcv/${encodeURIComponent(market)}?timeframe=${timeframe}&since=${since}&limit=${POINTS_PER_READ}`;
    const res = await doFetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (res.status === 400 || res.status === 404) {
      const body = (await res.json().catch(() => null)) as { code?: string; intafacedCode?: string } | null;
      if (body?.code === 'BadSymbol') return 'no_market';
      if (body?.intafacedCode === 'trade.candles_range_point_cap') return 'too_far';
      throw new Error(`market data refused ${market} ${timeframe}: ${res.status} ${body?.intafacedCode ?? ''}`);
    }
    if (!res.ok) throw new Error(`market data read failed ${market} ${timeframe}: ${res.status}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row: unknown) =>
      Array.isArray(row) && typeof row[0] === 'number' && typeof row[4] === 'string' ? [[row[0], row[4]] as [number, string]] : [],
    );
  };

  /** The last close before `from` on `market`, as a candle ended by `from`; null when none is found within reach. */
  const startClose = async (market: string, from: number): Promise<Amount | null> => {
    for (const { timeframe, ms, back } of START_LOOKBACK) {
      const since = Math.floor(from / ms) * ms - back * ms;
      // Only when the window back to now fits one read.
      if ((now().getTime() - since) / ms >= POINTS_PER_READ) continue;
      const rows = await candles(market, timeframe, since);
      if (!Array.isArray(rows)) continue;
      const last = rows.filter(([openAt]) => openAt + ms <= from).at(-1);
      if (last) return parseAmount(last[1]);
    }
    return null;
  };

  return {
    async closes(assetId, interval, from, to) {
      const frameMs = SERIES_TIMEFRAME_MS[interval];
      const since = Math.floor(from.getTime() / frameMs) * frameMs - frameMs;
      let first: CloseSeries | null = null;
      for (const quote of PRICE_QUOTES) {
        const market = `${assetId.toUpperCase()}/${quote}`;
        const rows = await candles(market, interval, since);
        if (rows === 'no_market') continue;
        if (rows === 'too_far') throw new Error(`market data refused ${market} ${interval} from ${new Date(since).toISOString()}`);
        const series: Array<readonly [number, Amount]> = rows
          .filter(([openAt]) => openAt <= to.getTime())
          .map(([openAt, close]) => [openAt, parseAmount(close)] as const);
        if (!series.some(([openAt]) => openAt + frameMs <= from.getTime())) {
          const start = await startClose(market, from.getTime());
          if (start !== null) series.unshift([from.getTime() - frameMs, start]);
        }
        const found = { market, candles: series };
        if (series.length > 0) return found;
        // A listed market that never traded: the next quote may have a price.
        first ??= found;
      }
      return first;
    },
  };
}

/** The close of the last candle that had ended by T; the candle still open only when T is the live end of the range. The
 * candles are oldest first, so the last one opened by T is found by halving. */
export function closeAt(series: CloseSeries, interval: ValueSeriesInterval, at: number, live: boolean): Amount | null {
  const ms = SERIES_TIMEFRAME_MS[interval];
  const candles = series.candles;
  // The count of candles opened at or before T (live), or ended by T (else).
  const limit = live ? at : at - ms;
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid]![0] <= limit) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? null : candles[lo - 1]![1];
}
