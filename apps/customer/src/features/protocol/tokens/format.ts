/**
 * Exact figures for the token pages. Amounts arrive as base-unit strings and prices as decimal strings; they are shown in
 * full, never rounded, so a row and the rows it sums read the same. No figure goes through a `number`.
 */
export function exactUnits(amount: string, decimals: number): string {
  const negative = amount.startsWith('-');
  const digits = (negative ? amount.slice(1) : amount).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Basis points as a signed percent with two places: 5000 → "+50.00%". */
export function percentFromBps(bps: number): string {
  const sign = bps > 0 ? '+' : bps < 0 ? '-' : '';
  const abs = Math.abs(bps);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

/** A chain time (unix seconds) as the ISO instant a `<time datetime>` and a candle's `data-time` both carry. */
export const isoTime = (seconds: number) => new Date(seconds * 1000).toISOString();

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
