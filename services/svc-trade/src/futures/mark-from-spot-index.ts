/**
 * Futures mark from our own spot book (D-instruments-01 residual).
 *
 * A futures market's mark has been the mid of its own matching book (`mark-from-depth.ts`). Every futures order is
 * banded around the mark (futures ADR section 1), so on an empty futures book no first order can be placed and the
 * book never fills: the mark has to come from somewhere other than the book it bounds. The owner can name a spot
 * market as a futures market's index; its book then marks the futures market, through the same depth gates as any
 * book mark, and the maintenance ladder rates positions against that same book (`depthNotionalSourceFromDepth`: the
 * rating and the mark describe one market).
 *
 * The pairing is the owner's: `TRADE_FUTURES_INDEX_SPOT_MARKETS`, `<futures symbol>=<spot symbol>` comma-separated.
 * Blank is off and every futures market reads its own book, as before. A pair whose spot market is missing, is not
 * spot, is not active, or does not share the futures market's base and quote reads NO book (no mark), never a nearby
 * price and never the futures book instead.
 */
import type { Market } from '../spot/types.js';

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

export type IndexMarket = Pick<Market, 'id' | 'symbol' | 'kind' | 'baseAsset' | 'quoteAsset' | 'status'>;

/** The service's own market reads (`TradeService.marketById` / `marketBySymbol`); tests pass a map. */
export interface IndexMarketLookup {
  byId(marketId: string): Promise<IndexMarket | null>;
  bySymbol(symbol: string): Promise<IndexMarket | null>;
}

/**
 * Which book marks `marketId`: its own (`marketId`) when no pair names it, the paired spot market's id when the pair
 * fits, and null when a pair names it but does not fit. Read each time: a listing or its status can change, and a
 * stale answer would mark a futures market against the wrong book.
 */
export type MarkBookResolver = (marketId: string) => Promise<string | null>;

export function markBookResolver(pairs: ReadonlyMap<string, string>, markets: IndexMarketLookup): MarkBookResolver | null {
  if (pairs.size === 0) return null;
  return async (marketId) => {
    const futures = await markets.byId(marketId);
    const spotSymbol = futures?.kind === 'futures' ? pairs.get(futures.symbol) : undefined;
    if (!futures || spotSymbol === undefined) return marketId;
    const spot = await markets.bySymbol(spotSymbol);
    if (!spot || spot.kind !== 'spot' || spot.status !== 'active') return null;
    if (spot.baseAsset !== futures.baseAsset || spot.quoteAsset !== futures.quoteAsset) return null;
    return spot.id;
  };
}
