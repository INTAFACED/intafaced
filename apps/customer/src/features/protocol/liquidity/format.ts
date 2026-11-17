import { formatUnits } from 'viem';

/** A base-unit amount in whole tokens, cut (never rounded up) to `places` decimals with trailing zeros dropped. */
export function amountText(raw: string | bigint, decimals: number, places = 6): string {
  const negative = BigInt(raw) < 0n;
  const whole = formatUnits(negative ? -BigInt(raw) : BigInt(raw), decimals);
  const [int, frac = ''] = whole.split('.');
  const cut = frac.slice(0, places).replace(/0+$/, '');
  return `${negative ? '-' : ''}${int}${cut ? `.${cut}` : ''}`;
}

/** Basis points as a percent with two places, from whole numbers only (30 → "0.30", -571 → "-5.71"). */
export function bpsPercent(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const n = Math.abs(bps);
  return `${sign}${Math.trunc(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

/**
 * A percent the person typed ("0.25", "1", "99") as whole bps, or null when it is not a non-negative number with at most
 * two decimals. The cap is checked by the caller, so "99" reads as 9900 and is refused there, not here.
 */
export function percentToBps(text: string): number | null {
  const m = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** Whole-token text to base units, or null when it is not a positive amount the token's decimals can hold. */
export function toUnits(text: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m || (m[2] ?? '').length > decimals) return null;
  const units = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
  return units > 0n ? units : null;
}

/** token1 per token0, from base units: "2" for 1000 A (6 decimals) against 2000 B (18 decimals). */
export function priceText(amount0: bigint, decimals0: number, amount1: bigint, decimals1: number, places = 6): string {
  if (amount0 === 0n) return '0';
  const scaled = (amount1 * 10n ** BigInt(decimals0) * 10n ** BigInt(places)) / (amount0 * 10n ** BigInt(decimals1));
  return amountText(scaled, places, places);
}
