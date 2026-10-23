import { parseAmount, type Amount } from '@intafaced/ledger-client';

/**
 * PRICE AT TIME. What one coin was worth in dollars when it arrived: the close of the candle that contains that moment,
 * on the coin's USDT market, else its USDC market (the same order the bank's valuation uses). The smallest candle with a
 * trade wins: one minute, then one hour, then one day. No candle means no price: the value stays unknown, never zero,
 * never today's price and never a price from a third market.
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
const FRAMES = [
  ['1m', 60_000],
  ['1h', 3_600_000],
  ['1d', 86_400_000],
] as const;
/** Technical bounds on one market data read, not business values: a timeout, and the most points the door returns. */
const READ_TIMEOUT_MS = 3_000;
const POINTS_PER_READ = 720;

export function createTradePrices(baseUrl: string, fetchImpl: typeof fetch = fetch): PriceAtTime {
  const base = baseUrl.replace(/\/$/, '');
  /** The first candle from `since` on, or why there is none: no such market, or the range is longer than one read may return. */
  const candle = async (market: string, timeframe: string, since: number): Promise<[number, string] | null | 'no_market' | 'too_far'> => {
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
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0] as unknown[];
    if (typeof row[0] !== 'number' || typeof row[4] !== 'string') return null;
    return [row[0], row[4]];
  };
  return {
    async priceAt(assetId, at) {
      const t = at.getTime();
      for (const quote of QUOTES) {
        const market = `${assetId.toUpperCase()}/${quote}`;
        for (const [timeframe, ms] of FRAMES) {
          const start = Math.floor(t / ms) * ms;
          const got = await candle(market, timeframe, start);
          if (got === 'no_market') break;
          if (got === 'too_far') continue; // too many small candles since then: try a bigger one
          if (got !== null && got[0] === start) return { price: parseAmount(got[1]), market, timeframe, candleAt: new Date(start) };
        }
      }
      return null;
    },
  };
}
