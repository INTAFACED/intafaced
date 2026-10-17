/**
 * Exact-decimal helpers the rooms share. Everything is a decimal string in and out; arithmetic is scaled bigint
 * (`data/decimal.ts`). No `Number`, no float, no `toFixed`. Unknown or malformed input is `null`, never zero.
 */
import { SCALE, add, dec, ratio, str, sub, times, type Scaled } from '../../../data/decimal';

export type Decimal = string;

export function positive(value: string | null | undefined): Scaled | null {
  const parsed = dec(value?.trim() ? value.trim() : null);
  return parsed !== null && parsed > 0n ? parsed : null;
}

/** price x amount, half-up at the ledger scale. Valuation for display only. */
export function notional(price: Decimal | null, amount: Decimal | null): Decimal | null {
  const p = dec(price);
  const a = dec(amount);
  return p === null || a === null ? null : str(times(p, a));
}

export function sumOf(values: ReadonlyArray<Decimal | null>): Decimal | null {
  let total: Scaled = 0n;
  for (const value of values) {
    const parsed = dec(value);
    if (parsed === null) return null;
    total = add(total, parsed);
  }
  return str(total);
}

/** Round DOWN to a whole number of steps. Null when the step or the value is not usable. */
export function floorToStep(value: Decimal, step: Decimal): Decimal | null {
  const v = positive(value);
  const s = positive(step);
  if (v === null || s === null) return null;
  return str((v / s) * s);
}

/** Round to the NEAREST whole step, half up. */
export function nearestStep(value: Decimal, step: Decimal): Decimal | null {
  const v = positive(value);
  const s = positive(step);
  if (v === null || s === null) return null;
  return str(((v + s / 2n) / s) * s);
}

export function onStep(value: Decimal, step: Decimal): boolean {
  const v = dec(value);
  const s = positive(step);
  return v !== null && s !== null && v % s === 0n;
}

/** a - b, null if either is unusable. */
export function minus(a: Decimal | null, b: Decimal | null): Decimal | null {
  const x = dec(a);
  const y = dec(b);
  return x === null || y === null ? null : str(sub(x, y));
}

export function compareDecimals(a: Decimal | null, b: Decimal | null): -1 | 0 | 1 | null {
  const x = dec(a);
  const y = dec(b);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Share of `part` in `whole` as a percent string with `places` decimals, half-up. Null when whole is zero or unknown. */
export function percentOf(part: Decimal | null, whole: Decimal | null, places = 2): Decimal | null {
  const p = dec(part);
  const w = dec(whole);
  if (p === null || w === null) return null;
  const r = ratio(p, w);
  if (r === null) return null;
  const hundred = dec('100')!;
  const pct = times(r, hundred);
  const factor = SCALE / 10n ** BigInt(places);
  const rounded = ((pct + factor / 2n) / factor) * factor;
  return str(rounded);
}

/**
 * Split `total` into `count` parts that sit on `lot` and add up to `total` exactly: equal parts rounded down to the lot,
 * and the remainder goes on the last part. Returns null when total or lot is unusable, count < 1, or a part would be 0.
 */
export function splitEqual(total: Decimal, count: number, lot: Decimal): Decimal[] | null {
  const t = positive(total);
  const l = positive(lot);
  if (t === null || l === null || !Number.isInteger(count) || count < 1) return null;
  const each = (t / BigInt(count) / l) * l;
  if (each <= 0n) return null;
  const parts = Array.from({ length: count }, () => each);
  parts[count - 1] = t - each * BigInt(count - 1);
  return parts.map(str);
}

/**
 * Split `total` into `count` parts with weights (any positive integers), rounded down to the lot, remainder on the last
 * part. Weights let the caller ask for ascending, descending or ratio sizes without any float.
 */
export function splitWeighted(total: Decimal, weights: readonly number[], lot: Decimal): Decimal[] | null {
  const t = positive(total);
  const l = positive(lot);
  if (t === null || l === null || weights.length < 1 || weights.some((w) => !Number.isInteger(w) || w < 1)) return null;
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => ((t * BigInt(w)) / BigInt(sum) / l) * l);
  if (parts.some((p) => p <= 0n)) return null;
  const used = parts.slice(0, -1).reduce((a, b) => a + b, 0n);
  parts[parts.length - 1] = t - used;
  return parts.map(str);
}

/** `count` prices from `start` to `end` inclusive, evenly spaced, each rounded to the nearest tick. Null if unusable. */
export function priceLadder(start: Decimal, end: Decimal, count: number, tick: Decimal): Decimal[] | null {
  const a = positive(start);
  const b = positive(end);
  const t = positive(tick);
  if (a === null || b === null || t === null || !Number.isInteger(count) || count < 2) return null;
  const n = BigInt(count - 1);
  const prices: Decimal[] = [];
  for (let i = 0n; i <= n; i += 1n) {
    const raw = a + ((b - a) * i) / n;
    prices.push(str(((raw + t / 2n) / t) * t));
  }
  return prices;
}
