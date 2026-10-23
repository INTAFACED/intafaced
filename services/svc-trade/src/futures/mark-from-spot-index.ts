/**
 * Futures mark from our own spot book (D-instruments-01 residual).
 *
 * A futures market's mark has been the mid of its own matching book (`mark-from-depth.ts`). Every futures order is
 * banded around the mark (futures ADR section 1), so on an empty futures book no first order can be placed and the
 * book never fills: the mark has to come from somewhere other than the book it bounds. This source reads the depth of
 * the spot market the owner names as the futures market's index, through the same depth gates as any book mark.
 *
 * The pairing is the owner's: `TRADE_FUTURES_INDEX_SPOT_MARKETS`, `<futures symbol>=<spot symbol>` comma-separated.
 * Blank is off and the mark is what it was. A pair whose spot market is missing, is not spot, or does not share the
 * futures market's base and quote answers null, never a nearby price.
 */
import type { Sql } from 'postgres';
import type { MarkSource } from './liquidation-tick.js';
import { markSourceFromDepth, type DepthReader } from './mark-from-depth.js';

/** `BTC/USDT:USDT=BTC/USDT` → Map(futures symbol → spot symbol). Blank is an empty map; a malformed pair throws. */
export function parseIndexSpotMarkets(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const text = (raw ?? '').trim();
  if (text === '') return out;
  for (const part of text.split(',')) {
    const pair = part.trim();
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const futures = eq > 0 ? pair.slice(0, eq).trim() : '';
    const spot = eq > 0 ? pair.slice(eq + 1).trim() : '';
    if (futures === '' || spot === '' || spot.includes('=')) {
      throw new Error(`TRADE_FUTURES_INDEX_SPOT_MARKETS: "${pair}" is not <futures symbol>=<spot symbol>`);
    }
    if (out.has(futures)) throw new Error(`TRADE_FUTURES_INDEX_SPOT_MARKETS: ${futures} is named twice`);
    out.set(futures, spot);
  }
  return out;
}

export interface IndexMarketRow {
  readonly id: string;
  readonly symbol: string;
  readonly kind: string;
  readonly base_asset: string;
  readonly quote_asset: string;
}

/** Market rows by id and by symbol. The service's own `trade.markets`; tests pass a map. */
export interface IndexMarketLookup {
  byId(marketId: string): Promise<IndexMarketRow | null>;
  bySymbol(symbol: string): Promise<IndexMarketRow | null>;
}

export function sqlIndexMarketLookup(sql: Sql): IndexMarketLookup {
  return {
    async byId(marketId) {
      const [row] = await sql<IndexMarketRow[]>`
        SELECT id, symbol, kind, base_asset, quote_asset FROM trade.markets WHERE id::text = ${marketId}`;
      return row ?? null;
    },
    async bySymbol(symbol) {
      const [row] = await sql<IndexMarketRow[]>`
        SELECT id, symbol, kind, base_asset, quote_asset FROM trade.markets WHERE symbol = ${symbol}`;
      return row ?? null;
    },
  };
}

/**
 * The spot market that indexes `futuresMarketId`, or null when the pairing names none or names one that does not
 * fit. Read each time: a listing can change, and a stale id would mark a futures market against the wrong book.
 */
export async function indexSpotMarketId(
  pairs: ReadonlyMap<string, string>,
  markets: IndexMarketLookup,
  futuresMarketId: string,
): Promise<string | null> {
  const futures = await markets.byId(futuresMarketId);
  if (!futures || futures.kind !== 'futures') return null;
  const spotSymbol = pairs.get(futures.symbol);
  if (!spotSymbol) return null;
  const spot = await markets.bySymbol(spotSymbol);
  if (!spot || spot.kind !== 'spot') return null;
  if (spot.base_asset !== futures.base_asset || spot.quote_asset !== futures.quote_asset) return null;
  return spot.id;
}

/** Null when no pair is configured, so the caller keeps today's mark source untouched. */
export function markSourceFromSpotIndex(input: {
  readonly pairs: ReadonlyMap<string, string>;
  readonly markets: IndexMarketLookup;
  readonly readDepth: DepthReader;
}): MarkSource | null {
  if (input.pairs.size === 0) return null;
  return markSourceFromDepth(async (futuresMarketId) => {
    const spotId = await indexSpotMarketId(input.pairs, input.markets, futuresMarketId);
    return spotId ? input.readDepth(spotId) : null;
  });
}
