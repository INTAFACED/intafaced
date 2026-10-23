import { parseAmount, type Amount } from '@intafaced/ledger-client';

/**
 * PRICE AT TIME. What one coin was worth in dollars when it arrived, on its USDT market, else its USDC market (the same
 * order the bank's valuation uses). Never a price from after the arrival beyond the minute it happened in:
 *
 * - one-minute candles: the close of the last candle that started at or before the arrival (the minute it arrived in,
 *   or the last minute before it that traded);
 * - when one-minute candles cannot be read that far back, hourly candles, then daily ones: the close of the last candle
 *   that ended at or before the arrival, so a later price within the hour or day is never used.
 *
 * No candle means no price: the value stays unknown, never zero, never today's price, never a third market's price. The
 * candle used is returned so the screen can say where the figure came from and when.
 *
 * Read from svc-trade's public market data (`/api/v1/ohlcv`), the same public read svc-bank's valuation makes.
 */

export interface PriceAt {
  readonly price: Amount;
  readonly market: string;
  readonly timeframe: '1m' | '1h' | '1d';
  readonly candleAt: Date;
}

export interface PriceAtTime {
  priceAt(assetId: string, at: Date): Promise<PriceAt | null>;
}

const QUOTES = ['USDT', 'USDC'] as const;
/**
 * Candle sizes in order, with how far back before the arrival each looks for its last candle. These are read windows
 * (how much history one request covers), not business values; a candle older than the window is not used.
 */
const FRAMES = [
  { timeframe: '1m', ms: 60_000, lookback: 60 },
  { timeframe: '1h', ms: 3_600_000, lookback: 24 },
  { timeframe: '1d', ms: 86_400_000, lookback: 30 },
] as const;
/** Technical bounds on one market data read, not business values: a timeout, and the most points the door returns. */
const READ_TIMEOUT_MS = 3_000;
const POINTS_PER_READ = 720;

type Rows = Array<[number, string]>;

export function createTradePrices(baseUrl: string, fetchImpl: typeof fetch = fetch): PriceAtTime {
  const base = baseUrl.replace(/\/$/, '');
  /** Candles from `since` on, or why there are none: no such market, or more candles than one read may return. */
  const candles = async (market: string, timeframe: string, since: number): Promise<Rows | 'no_market' | 'too_far'> => {
    const url = `${base}/api/v1/ohlcv/${encodeURIComponent(market)}?timeframe=${timeframe}&since=${since}&limit=${POINTS_PER_READ}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
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
  return {
    async priceAt(assetId, at) {
      const t = at.getTime();
      let failure: unknown = null;
      for (const quote of QUOTES) {
        const market = `${assetId.toUpperCase()}/${quote}`;
        frames: for (const frame of FRAMES) {
          const since = Math.floor(t / frame.ms) * frame.ms - frame.lookback * frame.ms;
          let rows: Awaited<ReturnType<typeof candles>>;
          try {
            rows = await candles(market, frame.timeframe, since);
          } catch (err) {
            failure = err; // one failed read: try the next candle size or market before giving up
            continue;
          }
          if (rows === 'no_market') break frames;
          if (rows === 'too_far') continue; // too many small candles since then: a bigger one
          // One-minute: the minute it arrived in counts. Bigger: only a candle that had ended by the arrival.
          const usable = rows.filter(([openAt]) => (frame.timeframe === '1m' ? openAt <= t : openAt + frame.ms <= t));
          const last = usable[usable.length - 1];
          if (last) return { price: parseAmount(last[1]), market, timeframe: frame.timeframe, candleAt: new Date(last[0]) };
        }
      }
      if (failure !== null) throw failure;
      return null;
    },
  };
}
