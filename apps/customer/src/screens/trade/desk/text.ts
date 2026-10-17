import { dec, fmtAmount, fmtPct, fmtPrice, fmtUsd, type TickerRow } from './deps';
import type { DeskMarket } from './market';

const DAY_MS = 24 * 60 * 60 * 1000;

export const isUsdQuote = (quote: string): boolean => quote === 'USDT' || quote === 'USDC' || quote === 'USD';

/**
 * A price in the market's own decimals, with no "$": the desk shows plain quote prices, as OKX does, and the quote asset
 * is named in the column headers (critic L8). Unknown is "—". Kept under its old name so the callers did not change.
 */
export function dollarPrice(value: string | null, market: Pick<DeskMarket, 'quote' | 'tickSize'>): string {
  return fmtPrice(value, market.tickSize);
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

/** Decimals a trade total shows in its quote asset: dollar coins have 6, others 8. Fixed, so a column lines up. */
export function quotePlaces(quote: string): number {
  return isUsdQuote(quote) ? 6 : 8;
}

/** Number of decimals an amount of this lot size has: "0.00001" -> 5. */
export function placesOf(step: string): number {
  const [, fraction = ''] = step.replace(/^-/, '').split('.');
  return fraction.replace(/0+$/, '').length;
}
