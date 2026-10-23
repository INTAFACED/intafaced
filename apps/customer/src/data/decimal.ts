/**
 * Exact decimal helpers for the data layer (UI-SPEC principle 5).
 *
 * Money crosses the wire as decimal strings and is combined here as scaled
 * bigints from `@intafaced/money-math`. Nothing in this folder turns a
 * money value into a JS number. Unknown or malformed input is `null`, never 0.
 */
import { SCALE, add, compare, div, formatAmount, mul, parseAmount, sub } from '@intafaced/money-math';
import type { Decimal } from './types';

export type Scaled = bigint;
export const ZERO: Scaled = 0n;

/** Parse a decimal string; null for missing or malformed input (never throws). */
export function dec(value: Decimal | null | undefined): Scaled | null {
  if (value === null || value === undefined) return null;
  try {
    return parseAmount(value);
  } catch {
    return null;
  }
}

/** Canonical decimal string (no trailing zeros, no exponent). */
export function str(value: Scaled): Decimal {
  return formatAmount(value);
}

export function decOrNull(value: Scaled | null): Decimal | null {
  return value === null ? null : formatAmount(value);
}

export function isPositive(value: Decimal | null | undefined): boolean {
  const parsed = dec(value);
  return parsed !== null && parsed > 0n;
}

/** a * b, rounded half-up at 18 places. Valuation only: never used to credit a user. */
export function times(a: Scaled, b: Scaled): Scaled {
  return mul(a, b, 'half-up');
}

/** a / b as a ratio at 18 places, half-up. Null when b is zero. */
export function ratio(a: Scaled, b: Scaled): Scaled | null {
  if (b === 0n) return null;
  return div(a, b, 'half-up');
}

export { SCALE, add, sub, compare };

/** Number of digits after the point once trailing zeros are dropped: "0.0100" -> 2, "1000" -> 0. */
export function fractionDigits(value: Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (dec(value) === null) return null;
  const [, fraction = ''] = value.trim().replace(/^-/, '').split('.');
  return fraction.replace(/0+$/, '').length;
}

/**
 * Round a scaled value to `places` decimals. `half-up` rounds away from zero on
 * a tie; `down` truncates toward zero (used where showing more than the user
 * holds would be wrong).
 */
export function roundScaled(value: Scaled, places: number, mode: 'half-up' | 'down' = 'half-up'): Scaled {
  const p = Math.max(0, Math.min(18, places));
  const unit = 10n ** BigInt(18 - p);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  let units = abs / unit;
  if (mode === 'half-up' && (abs % unit) * 2n >= unit) units += 1n;
  const rounded = units * unit;
  return negative ? -rounded : rounded;
}

/** Fixed-places string of a scaled value, e.g. 1.5 at 3 places -> "1.500", sign kept. */
export function toFixedString(value: Scaled, places: number): string {
  const p = Math.max(0, Math.min(18, places));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(18 - p);
  const units = abs / unit;
  const whole = units / 10n ** BigInt(p);
  const fraction = (units % 10n ** BigInt(p)).toString().padStart(p, '0');
  return `${negative && units !== 0n ? '-' : ''}${whole}${p > 0 ? `.${fraction}` : ''}`;
}

/** max / min / sum over scaled values; null for an empty list. */
export function maxOf(values: readonly Scaled[]): Scaled | null {
  let best: Scaled | null = null;
  for (const v of values) if (best === null || v > best) best = v;
  return best;
}
export function minOf(values: readonly Scaled[]): Scaled | null {
  let best: Scaled | null = null;
  for (const v of values) if (best === null || v < best) best = v;
  return best;
}
export function sumOf(values: readonly Scaled[]): Scaled {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** Compare two decimal strings; null if either is unknown. */
export function compareDecimal(a: Decimal | null | undefined, b: Decimal | null | undefined): -1 | 0 | 1 | null {
  const x = dec(a);
  const y = dec(b);
  if (x === null || y === null) return null;
  return compare(x, y);
}

/** Sign of a decimal string: 1, -1, 0, or null when unknown. */
export function signOf(value: Decimal | null | undefined): 1 | -1 | 0 | null {
  const parsed = dec(value);
  if (parsed === null) return null;
  return parsed > 0n ? 1 : parsed < 0n ? -1 : 0;
}
