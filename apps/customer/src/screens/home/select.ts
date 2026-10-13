import type { MarketRow, TickerRow } from './deps';
import { absDecimal, compareDecimal } from './deps';

/** One orderable market per asset, so BTC does not show twice for BTC/USDT and BTC/USDC. */
export interface Listing {
  base: string;
  symbol: string;
  market: MarketRow;
}

const quoteRank: Record<string, number> = { USDT: 0, USDC: 1 };
const fallbackOrder = ['BTC', 'ETH', 'IFC'];

export const isUsdQuote = (quote: string) => quote === 'USDT' || quote === 'USDC' || quote === 'USD';

export function listings(markets: MarketRow[]): Listing[] {
  const byBase = new Map<string, Listing>();
  for (const market of markets) {
    if (!market.orderable) continue;
    const current = byBase.get(market.base);
    const rank = quoteRank[market.quote] ?? 9;
    // A better quote replaces the entry; Map keeps the asset's first position in the list.
    if (!current || rank < (quoteRank[current.market.quote] ?? 9))
      byBase.set(market.base, { base: market.base, symbol: market.symbol, market });
  }
  return [...byBase.values()];
}

function fallbackIndex(list: Listing[], item: Listing): number {
  const named = fallbackOrder.indexOf(item.base);
  return named >= 0 ? named : fallbackOrder.length + list.indexOf(item);
}

/** Top cards: most 24h activity first; without activity numbers, BTC, ETH, IFC, then listing order. */
export function topCards(list: Listing[], tickers: Record<string, TickerRow> | undefined, count: number): Listing[] {
  const activity = (item: Listing) => tickers?.[item.symbol]?.quoteVolume24h ?? null;
  const active = (item: Listing) => compareDecimal(activity(item), '0') > 0;
  return [...list]
    .sort((a, b) => {
      if (active(a) !== active(b)) return active(a) ? -1 : 1;
      if (active(a) && active(b)) {
        const byActivity = compareDecimal(activity(b), activity(a));
        if (byActivity !== 0) return byActivity;
      }
      return fallbackIndex(list, a) - fallbackIndex(list, b);
    })
    .slice(0, count);
}

/** Biggest absolute 24h moves, gainers and losers together, one per asset. */
export function topMovers(
  rows: TickerRow[],
  baseOf: (symbol: string) => string | null,
  count: number,
): Array<{ base: string; ticker: TickerRow }> {
  const seen = new Set<string>();
  return rows
    .filter((row) => row.changePct24h !== null)
    .sort((a, b) => compareDecimal(absDecimal(b.changePct24h), absDecimal(a.changePct24h)))
    .flatMap((ticker) => {
      const base = baseOf(ticker.symbol);
      if (!base || seen.has(base)) return [];
      seen.add(base);
      return [{ base, ticker }];
    })
    .slice(0, count);
}
