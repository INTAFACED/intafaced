import { fmtPrice, type Loadable, type TickerRow } from './deps';
import { UNKNOWN } from './volt-parts';
import { isUsdQuote, type Listing } from './select';

export type Tickers = Loadable<Record<string, TickerRow>>;

/** "$64,815.49" for a dollar-quoted market, "0.0123 BTC" otherwise; an unknown price is a bare "—" (critic M3). */
export function priceText(item: Listing, ticker: TickerRow | undefined): string {
  const price = fmtPrice(ticker?.last, item.market.tickSize);
  if (price === UNKNOWN) return price;
  return isUsdQuote(item.market.quote) ? `$${price}` : `${price} ${item.market.quote}`;
}
