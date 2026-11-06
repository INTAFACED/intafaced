/**
 * The arithmetic of trading on the chart (J-charts-desk-15), kept apart from the drawing so it can be checked alone.
 *
 * A price read off the chart is a pointer position, a float the library reports. It is turned into a decimal string at
 * the market's tick here, once, and from then on every price is a decimal string compared as a scaled bigint: no money
 * value is held in a `number`.
 *
 * The protection distance is the owner's value (`orderProtectionBps`, svc-trade's chart owner values), in basis points of
 * the market's last price. A drag to a price further than that from the last price asks the person first, naming the
 * distance; while the owner has not set it, a drag refuses with the owner-value reason and nothing is asked or sent.
 */
import { formatAmount, parseAmount } from '../../../shared/money';

const parse = (value: string): bigint | null => {
  try {
    return parseAmount(value.trim());
  } catch {
    return null;
  }
};

/** The decimal places a tick is written with: "0.01" gives 2, "1" gives 0, "0.5" gives 1. */
export function tickPlaces(tick: string): number {
  const dot = tick.indexOf('.');
  return dot < 0 ? 0 : tick.length - dot - 1;
}

/**
 * A pointer price snapped to the nearest tick, as a decimal string with the tick's places ("65000.10"). Null when the
 * tick is not a positive decimal or the price is not a positive finite number, or snaps to zero.
 */
export function snapToTick(price: number, tick: string): string | null {
  const step = parse(tick);
  if (step === null || step <= 0n || !Number.isFinite(price) || price <= 0) return null;
  const places = tickPlaces(tick);
  // One more place than the tick has, so the rounding below is to the tick and not to the float's last digit.
  const read = parse(price.toFixed(Math.min(places + 1, 18)));
  if (read === null) return null;
  const snapped = ((read + step / 2n) / step) * step;
  if (snapped <= 0n) return null;
  return fixed(snapped, places);
}

/** A scaled value written with exactly `places` decimals (the value is already a multiple of 10^-places). */
function fixed(value: bigint, places: number): string {
  const text = formatAmount(value);
  if (places === 0) return text.split('.')[0]!;
  const [whole, frac = ''] = text.split('.');
  return `${whole}.${frac.padEnd(places, '0').slice(0, places)}`;
}

/** Whether a typed price is a positive multiple of the tick. */
export function onTick(price: string, tick: string): boolean {
  const value = parse(price);
  const step = parse(tick);
  return value !== null && step !== null && step > 0n && value > 0n && value % step === 0n;
}

export type ProtectionCheck =
  | { kind: 'unset' }
  | { kind: 'no-reference' }
  | { kind: 'within'; distance: string; limit: string }
  | { kind: 'beyond'; distance: string; limit: string };

/** Basis points as a percent with two places: 725 gives "7.25%". */
export function bpsText(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}%`;
}

/**
 * How far a new price is from the last price, against the owner's protection distance. The distance is rounded up to the
 * next basis point, so a price a hair past the limit is never read as inside it.
 */
export function protectionCheck(price: string, last: string | null, limitBps: number | null): ProtectionCheck {
  if (limitBps === null) return { kind: 'unset' };
  const to = parse(price);
  const from = last === null ? null : parse(last);
  if (to === null || from === null || from <= 0n) return { kind: 'no-reference' };
  const gap = to > from ? to - from : from - to;
  const distance = (gap * 10_000n + from - 1n) / from;
  const limit = BigInt(limitBps);
  return {
    kind: distance > limit ? 'beyond' : 'within',
    distance: bpsText(distance),
    limit: bpsText(limit),
  };
}

/** Prices compared as decimals: true when both parse and are equal ("60000.1" and "60000.10"). */
export function samePrice(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  return x !== null && y !== null && x === y;
}
