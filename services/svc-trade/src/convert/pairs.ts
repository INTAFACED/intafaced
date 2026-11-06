/**
 * What can be converted right now (J-cex-spot-11 #1, SP-convert-buy-02): the coins of every spot market a convert quote
 * would accept, each with its per-conversion limit, and the coins listed only on markets a quote would refuse.
 *
 * A market counts when the quote path's own gates pass for it (`buildConvertQuote`: spot surface, tradable, settlement
 * rails, venue open). A coin of a refused market that no accepted market also carries is `restricted`: the room never
 * offers it, so nobody types an amount for a coin that only refuses.
 *
 * The per-conversion limit is the owner's max-order notional (`TRADE_MAX_ORDER`, #4725), which the accept checks in the
 * pair's quote asset. Blank stays blank: `maxPerConvert` is null and the room says "Limit not set"; no number is invented.
 */
import { assertMarketOpen, assertSettlementRails, assertSpotSurface, assertTradable } from '../spot/risk.js';
import { TradeError, type Market } from '../spot/types.js';

export interface ConvertPairAsset {
  readonly asset: string;
  /** The owner's max-order notional, a whole number, in `asset` (the quote asset of this coin's pair). Null when blank. */
  readonly maxPerConvert: { readonly amount: string; readonly asset: string } | null;
}

export interface ConvertPairs {
  readonly assets: ConvertPairAsset[];
  /** Coins listed only on markets a convert quote refuses now. */
  readonly restricted: string[];
  /**
   * The operator's Convert kill-switch is off (`TRADE_CONVERT_ENABLED`): every quote and accept refuses
   * `trade.convert_disabled`, so the room says so before any price is asked for (J-cex-spot-11 #7).
   */
  readonly paused: boolean;
}

function convertible(market: Market, at: Date): boolean {
  try {
    assertSpotSurface(market, 'convert');
    assertTradable(market);
    assertSettlementRails(market);
    assertMarketOpen(market, at);
    return true;
  } catch {
    return false;
  }
}

/** The quote asset a coin's conversions are counted in: its own when it is one, else its first open pair's, by symbol. */
function limitAssetFor(asset: string, open: readonly Market[]): string {
  if (open.some((m) => m.quoteAsset === asset)) return asset;
  const pairs = open.filter((m) => m.baseAsset === asset).sort((a, b) => a.symbol.localeCompare(b.symbol));
  return pairs[0]!.quoteAsset;
}

export function convertPairs(markets: readonly Market[], at: Date, maxOrder: number | null, paused = false): ConvertPairs {
  const open = markets.filter((m) => convertible(m, at));
  const offered = new Set(open.flatMap((m) => [m.baseAsset, m.quoteAsset]));
  const refusedOnly = new Set(markets.filter((m) => m.kind === 'spot' && !open.includes(m)).flatMap((m) => [m.baseAsset, m.quoteAsset]));
  const assets = [...offered].sort().map((asset) => ({
    asset,
    maxPerConvert: maxOrder === null ? null : { amount: String(maxOrder), asset: limitAssetFor(asset, open) },
  }));
  return { assets, restricted: [...refusedOnly].filter((a) => !offered.has(a)).sort(), paused };
}

/**
 * ISO 4217 cash currencies the route check recognises. A standard's codes, not a business value: it names what a
 * currency is, never what may be converted (that is the markets' list).
 */
const CASH = new Set([
  'AED',
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'JPY',
  'KRW',
  'MXN',
  'MYR',
  'NOK',
  'NZD',
  'PHP',
  'PLN',
  'RON',
  'SAR',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'USD',
  'ZAR',
]);

export type ConvertRoute = { readonly kind: 'direct'; readonly symbol: string; readonly side: 'buy' | 'sell' };

/**
 * How `from` converts to `to` (J-cex-spot-11 #11): a convertible market joining them, bought or sold. A cash currency
 * with no direct market would need two linked legs through a crypto leg, which are not built: refused by name
 * (`trade.convert_two_leg_unbuilt`), never quoted as one leg or priced from a guess.
 */
export function convertRoute(markets: readonly Market[], at: Date, from: string, to: string): ConvertRoute {
  const open = markets.filter((m) => convertible(m, at));
  const buy = open.find((m) => m.baseAsset === to && m.quoteAsset === from);
  if (buy) return { kind: 'direct', symbol: buy.symbol, side: 'buy' };
  const sell = open.find((m) => m.baseAsset === from && m.quoteAsset === to);
  if (sell) return { kind: 'direct', symbol: sell.symbol, side: 'sell' };
  const offered = new Set(open.flatMap((m) => [m.baseAsset, m.quoteAsset]));
  const cashSide = CASH.has(from) ? to : CASH.has(to) ? from : null;
  if (cashSide !== null && from !== to && offered.has(cashSide)) {
    throw new TradeError(
      `${from} to ${to} needs two linked legs through a crypto leg, which are not built; nothing was quoted`,
      'trade.convert_two_leg_unbuilt',
      { from, to },
    );
  }
  throw new TradeError(`no market converts ${from} to ${to}; nothing was quoted`, 'trade.convert_pair_unlisted', { from, to });
}
