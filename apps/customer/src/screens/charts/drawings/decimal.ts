/**
 * Exact price arithmetic for the drawing tools. Prices cross the wire and sit in the stored drawings as decimal strings;
 * arithmetic is scaled bigint (18 places, from `data/decimal`), and a JS number appears only where a canvas needs a
 * coordinate (`render.ts`). Nothing here turns a price into a number that is stored.
 */
import { dec, fractionDigits, roundScaled, times, ratio, add, sub, toFixedString, type Scaled } from '../../../data/decimal';

export type Decimal = string;
export { dec, add, sub, times, ratio, toFixedString, type Scaled };

/** Decimal places a tick size implies: "0.01" -> 2. A blank, malformed or non-positive tick is null: the caller refuses. */
export function tickPlaces(tick: Decimal): number | null {
  const scaled = dec(tick);
  if (scaled === null || scaled <= 0n) return null;
  return fractionDigits(tick);
}

/**
 * The nearest multiple of `tick` (half away from zero), as a decimal string at the tick's own places. Null when the value
 * or the tick is not a valid decimal, or the tick is not positive.
 */
export function roundToTick(value: Decimal | Scaled, tick: Decimal): Decimal | null {
  const v = typeof value === 'bigint' ? value : dec(value);
  const t = dec(tick);
  const places = tickPlaces(tick);
  if (v === null || t === null || t <= 0n || places === null) return null;
  const negative = v < 0n;
  const a = negative ? -v : v;
  let steps = a / t;
  if ((a % t) * 2n >= t) steps += 1n;
  const snapped = steps * t;
  return toFixedString(negative ? -snapped : snapped, places);
}

/** A canvas number (a pointer position's price) as a tick-rounded decimal string; null for a non-finite number. */
export function priceFromNumber(price: number, tick: Decimal): Decimal | null {
  if (!Number.isFinite(price)) return null;
  return roundToTick(price.toFixed(18), tick);
}

/** Decimal price difference `b - a` at the tick's places. Null when either side is not a valid decimal. */
export function diffAtTick(a: Decimal, b: Decimal, tick: Decimal): Decimal | null {
  const x = dec(a);
  const y = dec(b);
  if (x === null || y === null) return null;
  return roundToTick(sub(y, x), tick);
}

/** Percentage `(b - a) / a * 100`, two places, half-up. Null for a zero or invalid base. */
export function percentChange(a: Decimal, b: Decimal): Decimal | null {
  const x = dec(a);
  const y = dec(b);
  if (x === null || y === null || x === 0n) return null;
  const change = ratio(sub(y, x), x);
  if (change === null) return null;
  return toFixedString(roundScaled(times(change, 100n * 10n ** 18n), 2), 2);
}

/** Ratio `a / b` to two places, half-up. Null when b is zero or either side is invalid. */
export function ratioText(a: Decimal | Scaled, b: Decimal | Scaled): Decimal | null {
  const x = typeof a === 'bigint' ? a : dec(a);
  const y = typeof b === 'bigint' ? b : dec(b);
  if (x === null || y === null || y === 0n) return null;
  const r = ratio(x, y);
  if (r === null) return null;
  return toFixedString(roundScaled(r, 2), 2);
}
