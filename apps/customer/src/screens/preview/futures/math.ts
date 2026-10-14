// Exact decimal maths for the futures Preview. Money is a scaled bigint end to end (data/decimal.ts); nothing here uses a float.
import { dec, ratio, times, SCALE, type Scaled } from '../../../data/decimal';
import type { PerpSide } from '../../../preview/fixtures/futures';

/** A sample number out of the fixture. A malformed one is a bug in the fixture, so it throws loudly (the fixture test catches it). */
export function d(value: string): Scaled {
  const parsed = dec(value);
  if (parsed === null) throw new Error(`Sample number is not a decimal: ${value}`);
  return parsed;
}

/** Profit or loss on a position if it closed at `price`, in US dollars. Long gains when the price rises, short when it falls. */
export function unrealisedPnl(side: PerpSide, size: Scaled, entry: Scaled, price: Scaled): Scaled {
  return times(size, side === 'long' ? price - entry : entry - price);
}

/** What the position is worth at `price`, in US dollars. */
export function positionValue(size: Scaled, price: Scaled): Scaled {
  return times(size, price);
}

/** Margin an order needs at a leverage: its value divided by the leverage. */
export function marginFor(value: Scaled, leverage: number): Scaled {
  return value / BigInt(leverage);
}

/**
 * Estimated price at which the margin no longer covers the loss plus the maintenance margin. `extra` is money outside the position
 * that also backs it (cross margin). An estimate: fees and funding move the real figure. Never below zero.
 */
export function liquidationPrice(args: {
  side: PerpSide;
  size: Scaled;
  entry: Scaled;
  margin: Scaled;
  maintenanceMargin: Scaled;
  extra?: Scaled;
}): Scaled | null {
  const { side, size, entry, margin, maintenanceMargin, extra = 0n } = args;
  if (size <= 0n) return null;
  const maintenance = times(times(size, entry), maintenanceMargin);
  const perUnit = ratio(margin + extra - maintenance, size);
  if (perUnit === null) return null;
  const price = side === 'long' ? entry - perUnit : entry + perUnit;
  return price < 0n ? 0n : price;
}

/** Return on the margin as a ratio ("0.169" is +16.9%); null when there is no margin. */
export function returnOnMargin(pnl: Scaled, margin: Scaled): Scaled | null {
  return margin === 0n ? null : ratio(pnl, margin);
}

/** Round a value down to a multiple of `step` (a lot or a tick). */
export function floorTo(value: Scaled, step: Scaled): Scaled {
  return step <= 0n ? value : (value / step) * step;
}

/** The biggest size a wallet can open at a leverage and price, kept to whole lots. */
export function maxSize(available: Scaled, leverage: number, price: Scaled, lot: Scaled): Scaled {
  const raw = ratio(available * BigInt(leverage), price);
  return raw === null ? 0n : floorTo(raw, lot);
}

/** `percent` (0 to 100) of a size, kept to whole lots. */
export function percentOfSize(size: Scaled, percent: number, lot: Scaled): Scaled {
  return floorTo((size * BigInt(percent)) / 100n, lot);
}

/** Share of `part` in `whole` as a whole-number percent for drawing a bar (pixels, never money). */
export function barPercent(part: Scaled, whole: Scaled): number {
  if (whole <= 0n) return 0;
  return Number((part * 100n) / whole);
}

export const ONE = SCALE;
