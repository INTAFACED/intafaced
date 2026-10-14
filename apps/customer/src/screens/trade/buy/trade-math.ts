/**
 * Exact arithmetic for the Buy and Convert screens. Every value is a decimal string on the wire and a scaled
 * bigint (10^18) here; there is no JS float anywhere in this file (the no-float scan covers `screens/**`).
 * Rounding is always explicit and always against the customer's surprise: amounts the customer will pay or
 * send round DOWN, the minimums they must clear round as published.
 */
import { SCALE, dec, fractionDigits, str, type Scaled } from '../../../data/decimal';

export { dec, str, SCALE, fractionDigits };
export type { Scaled };

/** a * b at 18 places, rounded down. */
export function mulDown(a: Scaled, b: Scaled): Scaled {
  return (a * b) / SCALE;
}

/** a * b at 18 places, rounded up (a fee or a hold the customer must cover). */
export function mulUp(a: Scaled, b: Scaled): Scaled {
  const product = a * b;
  return product / SCALE + (product % SCALE === 0n ? 0n : 1n);
}

/** a / b at 18 places, rounded down. Null when b is not positive. */
export function divDown(a: Scaled, b: Scaled): Scaled | null {
  return b > 0n ? (a * SCALE) / b : null;
}

/** The largest multiple of `step` not above `value`. A non-positive step has no valid size, so 0. */
export function floorToStep(value: Scaled, step: Scaled): Scaled {
  return step > 0n && value > 0n ? (value / step) * step : 0n;
}

/** True when `value` is an exact multiple of `step`. */
export function isMultipleOf(value: Scaled, step: Scaled): boolean {
  return step > 0n && value % step === 0n;
}

/** Basis points as a ratio: 20 bps is 0.002. */
export function bpsRatio(bps: number): Scaled {
  return (BigInt(bps) * SCALE) / 10_000n;
}

/** Decimal string of a scaled value cut to `places` decimals, rounded down, trailing zeros dropped. */
export function toPlaces(value: Scaled, places: number): string {
  const p = Math.max(0, Math.min(18, places));
  const unit = 10n ** BigInt(18 - p);
  return str((value / unit) * unit);
}

/** Decimal string cut to `places` decimals, rounded down, or null when it is not a decimal at all. */
export function cutDecimal(value: string | null | undefined, places: number): string | null {
  const parsed = dec(value);
  return parsed === null ? null : toPlaces(parsed, places);
}

/** The smallest multiple of `step` not below `value`. */
export function ceilToStep(value: Scaled, step: Scaled): Scaled {
  if (step <= 0n || value <= 0n) return 0n;
  return value % step === 0n ? value : (value / step + 1n) * step;
}

/** a / b at 18 places, rounded up. Null when b is not positive. */
export function divUp(a: Scaled, b: Scaled): Scaled | null {
  if (b <= 0n) return null;
  const product = a * SCALE;
  return product / b + (product % b === 0n ? 0n : 1n);
}

/** Round up to `places` decimals ("5" stays "5", "5.001" at 2 places is "5.01"). Used for the minimums we quote. */
export function ceilPlaces(value: Scaled, places: number): Scaled {
  const p = Math.max(0, Math.min(18, places));
  return ceilToStep(value, 10n ** BigInt(18 - p));
}
