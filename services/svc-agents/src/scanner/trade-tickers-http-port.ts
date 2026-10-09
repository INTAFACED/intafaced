/**
 * Live spot tickers from svc-trade public REST (`GET /api/v1/tickers`).
 *
 * Unset TRADE_URL in production = honest `no_live_tickers`. This port maps only
 * fields the trade plane publishes — never invents 24h stats when trade returns null.
 */

import { z } from 'zod';
import { assertTickersPageLimit } from '../errors.js';
import type { TickerFixture } from './data-tools.js';
import type { SpotTickersPort } from './spot-tickers-port.js';

const tradeTickerWireSchema = z.object({
  symbol: z.string(),
  timestamp: z.number(),
  last: z.string().nullable(),
  quoteVolume: z.string().nullable(),
  baseVolume: z.string().nullable(),
  percentage: z.string().nullable(),
});

export type HttpSpotTickersOptions = {
  readonly tradeUrl: string;
  /** Default maxAgeMs stamped on each mapped fixture row. */
  readonly maxAgeMs?: number;
  /**
   * Owner-published page size for `GET /api/v1/tickers?limit=`.
   * Unset here AND at `sample(limit)` refuses named — never invent 500.
   */
  readonly limit?: number;
  readonly fetchImpl?: typeof fetch;
};

/** CCXT unified symbol (BTC/USDT) → scanner marketId (btc-usdt). */
export function symbolToScannerMarketId(symbol: string): string {
  return symbol.trim().toLowerCase().replace('/', '-');
}

function percentageToChangeBps(percentage: string | null): number | null {
  if (percentage === null || percentage.trim() === '') return null;
  const n = Number(percentage);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function mapTicker(symbol: string, raw: unknown, maxAgeMs: number): TickerFixture | null {
  const parsed = tradeTickerWireSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  if (symbolToScannerMarketId(row.symbol) !== symbolToScannerMarketId(symbol)) return null;
  if (row.last === null || row.last.trim() === '') return null;
  return {
    marketId: symbolToScannerMarketId(symbol),
    last: row.last,
    volume24h: row.quoteVolume ?? row.baseVolume,
    change24hBps: percentageToChangeBps(row.percentage),
    asOf: new Date(row.timestamp).toISOString(),
    maxAgeMs,
  };
}

/**
 * Live tickers: trade public REST only. Transport/parse failure throws so
 * `readLiveSpotTickers` collapses to `no_live_tickers`.
 */
export function createHttpSpotTickersPort(options: HttpSpotTickersOptions): SpotTickersPort {
  const tradeUrl = options.tradeUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAgeMs = options.maxAgeMs ?? 60_000;

  return {
    async sample(limit) {
      const page = assertTickersPageLimit(limit ?? options.limit);
      let response: Response;
      try {
        response = await fetchImpl(`${tradeUrl}/api/v1/tickers?limit=${encodeURIComponent(String(page))}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
      } catch {
        throw new Error('trade unreachable');
      }
      if (!response.ok) throw new Error('trade unreachable');
      const body: unknown = await response.json().catch(() => null);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('trade tickers parse failed');
      }
      const tickers: TickerFixture[] = [];
      for (const [symbol, raw] of Object.entries(body as Record<string, unknown>)) {
        const mapped = mapTicker(symbol, raw, maxAgeMs);
        if (mapped !== null) tickers.push(mapped);
      }
      return tickers;
    },
  };
}
