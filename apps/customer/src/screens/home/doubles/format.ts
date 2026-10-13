// TODO(B1/B3): remove double. Stand-in for apps/customer/src/data/format.ts (UI-SPEC §2.6).
// Exact decimal-string arithmetic with bigint; no floats.
import type { Decimal } from '../../../data/types';

interface Dec {
  neg: boolean;
  digits: bigint;
  scale: number;
}

function parse(value: Decimal | null | undefined): Dec | null {
  if (value == null) return null;
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? '';
  return { neg: match[1] === '-', digits: BigInt((match[2] ?? '0') + fraction), scale: fraction.length };
}

/** Round half away from zero to `places` decimals; scale may be negative. */
function rescale(digits: bigint, scale: number, places: number): bigint {
  const shift = places - scale;
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  const quotient = digits / divisor;
  return (digits % divisor) * 2n >= divisor ? quotient + 1n : quotient;
}

function fixed(magnitude: bigint, places: number): string {
  const text = magnitude.toString().padStart(places + 1, '0');
  const whole = places === 0 ? text : text.slice(0, -places);
  const fraction = places === 0 ? '' : text.slice(-places);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

const MINUS = '−';

export type Direction = 'up' | 'down' | 'flat';

export function directionOf(value: Decimal | null | undefined): Direction {
  const dec = parse(value);
  if (!dec || dec.digits === 0n) return 'flat';
  return dec.neg ? 'down' : 'up';
}

function usd(value: Decimal | null | undefined, signed: boolean): string {
  const dec = parse(value);
  if (!dec) return '—';
  const small = rescale(dec.digits, dec.scale, 4) < 10000n && dec.digits !== 0n;
  let places = small ? 4 : 2;
  let magnitude = rescale(dec.digits, dec.scale, places);
  if (small) {
    // Up to 4 decimals, but never fewer than 2.
    while (places > 2 && magnitude % 10n === 0n) {
      magnitude /= 10n;
      places -= 1;
    }
  }
  const sign = magnitude === 0n ? '' : dec.neg ? MINUS : signed ? '+' : '';
  return `${sign}$${fixed(magnitude, places)}`;
}

export const fmtUsd = (value: Decimal | null | undefined) => usd(value, false);
export const fmtSignedUsd = (value: Decimal | null | undefined) => usd(value, true);

/** Input is a ratio string ("-0.0028" -> "−0.28%"). */
export function fmtPct(ratio: Decimal | null | undefined): string {
  const dec = parse(ratio);
  if (!dec) return '—';
  const magnitude = rescale(dec.digits, dec.scale - 2, 2);
  const sign = magnitude === 0n ? '' : dec.neg ? MINUS : '+';
  return `${sign}${fixed(magnitude, 2)}%`;
}

/** Decimals = the market's tick size. `usdQuote` adds the dollar sign. */
export function fmtPrice(value: Decimal | null | undefined, tickSize: Decimal | null | undefined, usdQuote = true): string {
  const dec = parse(value);
  if (!dec) return '—';
  const tick = (tickSize ?? '').includes('.') ? (tickSize ?? '').replace(/0+$/, '') : '';
  const places = tick.includes('.') ? tick.split('.')[1]!.length : 0;
  const magnitude = rescale(dec.digits, dec.scale, places);
  const sign = magnitude === 0n ? '' : dec.neg ? MINUS : '';
  return `${sign}${usdQuote ? '$' : ''}${fixed(magnitude, places)}`;
}

/** Compare two decimal strings exactly. Unknown sorts as smallest. */
export function compareDecimal(a: Decimal | null | undefined, b: Decimal | null | undefined): number {
  const x = parse(a);
  const y = parse(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  const scale = Math.max(x.scale, y.scale);
  const left = (x.neg ? -1n : 1n) * x.digits * 10n ** BigInt(scale - x.scale);
  const right = (y.neg ? -1n : 1n) * y.digits * 10n ** BigInt(scale - y.scale);
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Absolute value of a decimal string, for sorting by size of move. */
export function absDecimal(value: Decimal | null | undefined): Decimal | null {
  const dec = parse(value);
  if (!dec) return null;
  const text = dec.digits.toString().padStart(dec.scale + 1, '0');
  return dec.scale === 0 ? text : `${text.slice(0, -dec.scale)}.${text.slice(-dec.scale)}`;
}
