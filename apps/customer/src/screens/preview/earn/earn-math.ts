import { dec, ratio, str, times, SCALE } from '../../../data/decimal';

/**
 * Sample-earnings arithmetic for the Earn Preview. Scaled-bigint work only: no money value becomes a JS number.
 * The result is an ILLUSTRATION of a sample rate, never a promise, and the screen says so next to every figure.
 */
const DAYS_IN_YEAR = 365n;
const HUNDRED = 100n;

/** amount x (rate % a year) x days / 365, as a decimal string; null when an input is not a decimal string. */
export function sampleReward(amount: string, ratePct: string, days: number): string | null {
  const a = dec(amount);
  const r = dec(ratePct);
  if (a === null || r === null || !Number.isInteger(days) || days < 0) return null;
  const perYear = ratio(times(a, r), HUNDRED * SCALE);
  if (perYear === null) return null;
  return str((perYear * BigInt(days)) / DAYS_IN_YEAR);
}

/** Sum of decimal strings; entries that do not parse are skipped. */
export function sumDecimals(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) total += dec(value) ?? 0n;
  return str(total);
}

/** amount x USD price as a decimal string; null when either is not a decimal string. */
export function worth(amount: string, price: string): string | null {
  const a = dec(amount);
  const p = dec(price);
  return a === null || p === null ? null : str(times(a, p));
}

/** True when `amount` is a positive decimal that is at least `min`. */
export function meetsMinimum(amount: string, min: string): boolean {
  const a = dec(amount);
  const m = dec(min);
  return a !== null && m !== null && a > 0n && a >= m;
}
