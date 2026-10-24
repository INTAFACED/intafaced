import { dec, fmtAmount, fmtUsd, SCALE } from './deps';

const SMALLEST_USD = SCALE / 10_000n;

/**
 * A coin's USD price as the valuation used it: dollars and cents, or four places under a dollar, and a price under a
 * hundredth of a cent in full rather than "<$0.0001", so the price behind a value is never hidden.
 */
export function fmtCoinPrice(value: string): string {
  const parsed = dec(value);
  if (parsed !== null && parsed > 0n && parsed < SMALLEST_USD) return `$${fmtAmount(value, { places: 18 })}`;
  return fmtUsd(value);
}

/** "BTC-USDT" as the market's own name, "BTC/USDT": only the last hyphen separates base and quote. */
export function marketName(symbol: string): string {
  return symbol.replace(/-(?=[^-]*$)/, '/');
}
