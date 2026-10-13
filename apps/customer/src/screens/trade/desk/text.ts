import { dec, fmtAmount, fmtPct, fmtPrice, fmtUsd, type TickerRow } from './deps';
import type { DeskMarket } from './market';

const DAY_MS = 24 * 60 * 60 * 1000;

export const isUsdQuote = (quote: string): boolean => quote === 'USDT' || quote === 'USDC' || quote === 'USD';

/** A price with "$" when the market is quoted in a dollar-pegged asset (critic: prices carry "$"). Unknown is "—". */
export function dollarPrice(value: string | null, market: Pick<DeskMarket, 'quote' | 'tickSize'>): string {
  const text = fmtPrice(value, market.tickSize);
  return isUsdQuote(market.quote) && text !== '—' ? `$${text}` : text;
}

/** "+153.50" / "−153.50": a signed price change in the market's price decimals. */
export function signedPrice(change: string | null, tickSize: string): string {
  const text = fmtPrice(change, tickSize);
  const value = dec(change);
  return value !== null && value > 0n ? `+${text}` : text;
}

/** "−153.50 (−0.18%)", or "—" when the change is unknown. */
export function changeLine(ticker: Pick<TickerRow, 'change24h' | 'changePct24h'>, tickSize: string): string {
  if (dec(ticker.change24h) === null) return dec(ticker.changePct24h) === null ? '—' : fmtPct(ticker.changePct24h);
  const amount = signedPrice(ticker.change24h, tickSize);
  return dec(ticker.changePct24h) === null ? amount : `${amount} (${fmtPct(ticker.changePct24h)})`;
}

/** When the 24h figures cover less than a day (a market younger than 24 h), the epoch ms they start at; else null. */
export function partialWindowStart(ticker: Pick<TickerRow, 'windowStart'>, nowMs: number): number | null {
  const start = ticker.windowStart;
  return start !== null && start > nowMs - DAY_MS ? start : null;
}

/** Compact volume: "$1.2M" for dollar-quoted turnover, else the plain amount. */
export function turnoverText(value: string | null, quote: string): string {
  return isUsdQuote(quote) ? fmtUsd(value, { compact: true }) : fmtAmount(value, { places: 2 });
}

/** Number of decimals an amount of this lot size has: "0.00001" -> 5. */
export function placesOf(step: string): number {
  const [, fraction = ''] = step.replace(/^-/, '').split('.');
  return fraction.replace(/0+$/, '').length;
}
