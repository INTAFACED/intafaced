/**
 * Live navigator trade data from svc-trade public REST.
 *
 * Maps only fields trade publishes — never invents last prices or market status.
 */

import { z } from 'zod';
import { assertNavigatorMarketsPageLimit } from '../errors.js';
import type { MarketListFixture, QuoteFixture } from './data-tools.js';
import type { NavigatorTradeDataPort } from './trade-data-port.js';

const tradeMarketWireSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  active: z.boolean(),
  sessionOpen: z.boolean(),
});

const tradeTickerWireSchema = z.object({
  symbol: z.string(),
  timestamp: z.number(),
  datetime: z.string(),
  last: z.string().nullable(),
});

export type HttpNavigatorTradeDataOptions = {
  readonly tradeUrl: string;
  readonly maxAgeMs?: number;
  /**
   * Owner-published page size for `GET /api/v1/markets?limit=`.
   * Unset here AND at `listMarkets(limit)` refuses named — never invent 50.
   */
  readonly marketsLimit?: number;
  readonly fetchImpl?: typeof fetch;
};

/** CCXT unified symbol (BTC/USDT) → navigator marketId (btc-usdt). */
export function symbolToNavigatorMarketId(symbol: string): string {
  return symbol.trim().toLowerCase().replace('/', '-');
}

/** Navigator marketId (btc-usdt) → CCXT symbol for trade REST params. */
export function navigatorMarketIdToSymbol(marketId: string): string {
  const parts = marketId.trim().toLowerCase().split('-');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('invalid navigator marketId');
  }
  return `${parts[0].toUpperCase()}/${parts[1].toUpperCase()}`;
}

function mapMarketStatus(active: boolean, sessionOpen: boolean): MarketListFixture['status'] {
  if (!active) return 'closed';
  if (!sessionOpen) return 'halted';
  return 'open';
}

function mapMarket(row: z.infer<typeof tradeMarketWireSchema>): MarketListFixture {
  return {
    marketId: symbolToNavigatorMarketId(row.symbol),
    symbol: row.symbol,
    status: mapMarketStatus(row.active, row.sessionOpen),
  };
}

/** Ticker body names a different instrument than the symbol on the ticker URL. */
export class TradeTickerSymbolMismatchError extends Error {
  readonly code = 'trade.ticker_symbol_mismatch' as const;

  constructor(
    readonly urlSymbol: string,
    readonly bodySymbol: string,
  ) {
    super(`ticker body symbol ${bodySymbol} does not match ticker URL symbol ${urlSymbol}`);
    this.name = 'TradeTickerSymbolMismatchError';
  }
}

function mapQuote(marketId: string, urlSymbol: string, row: z.infer<typeof tradeTickerWireSchema>, maxAgeMs: number): QuoteFixture | null {
  if (row.symbol !== urlSymbol) {
    throw new TradeTickerSymbolMismatchError(urlSymbol, row.symbol);
  }
  if (row.last === null || row.last.trim() === '') return null;
  return {
    marketId,
    last: row.last,
    asOf: row.datetime,
    maxAgeMs,
  };
}

export function createHttpNavigatorTradeDataPort(options: HttpNavigatorTradeDataOptions): NavigatorTradeDataPort {
  const tradeUrl = options.tradeUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAgeMs = options.maxAgeMs ?? 60_000;

  return {
    async listMarkets(limit) {
      const page = assertNavigatorMarketsPageLimit(limit ?? options.marketsLimit);
      let response: Response;
      try {
        response = await fetchImpl(`${tradeUrl}/api/v1/markets?limit=${encodeURIComponent(String(page))}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
      } catch {
        throw new Error('trade unreachable');
      }
      if (!response.ok) throw new Error('trade unreachable');
      const body: unknown = await response.json().catch(() => null);
      if (!Array.isArray(body)) throw new Error('trade markets parse failed');
      const markets: MarketListFixture[] = [];
      for (const raw of body) {
        const parsed = tradeMarketWireSchema.safeParse(raw);
        if (!parsed.success) continue;
        markets.push(mapMarket(parsed.data));
      }
      return markets;
    },

    async quote(marketId) {
      const symbol = navigatorMarketIdToSymbol(marketId);
      let response: Response;
      try {
        response = await fetchImpl(`${tradeUrl}/api/v1/ticker/${encodeURIComponent(symbol)}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
      } catch {
        throw new Error('trade unreachable');
      }
      if (!response.ok) throw new Error('trade unreachable');
      const body: unknown = await response.json().catch(() => null);
      const parsed = tradeTickerWireSchema.safeParse(body);
      if (!parsed.success) throw new Error('trade ticker parse failed');
      const quote = mapQuote(marketId, symbol, parsed.data, maxAgeMs);
      if (quote === null) throw new Error('trade ticker empty last');
      return quote;
    },
  };
}
