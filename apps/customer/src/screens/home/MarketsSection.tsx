import { type Loadable, type TickerRow } from './deps';
import { type Listing } from './select';
import { priceText as marketPriceText } from '../trade/markets/select';

export type Tickers = Loadable<Record<string, TickerRow>>;

/**
 * A card's price, as the Markets list writes it (one formatter): "$64,815.49" for a dollar-quoted
 * market, "0.0123 BTC" otherwise, at the market's display tick; an unknown price is a bare "—" (critic M3).
 */
export function priceText(item: Listing, ticker: TickerRow | undefined): string {
  return marketPriceText(item.market, ticker?.last);
}
