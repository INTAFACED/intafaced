// The level prices a spot grid would use, for the wizard's preview only: the service plans the real levels and its
// answer replaces this one. Same rule as svc-trade grid/plan.ts: evenly spaced from lower to upper inclusive, each
// rounded down onto the market's price step. Exact decimals throughout; nothing here is a number of money.
import { dec, str } from '../../../data/decimal';

export type GridPreview = { kind: 'levels'; prices: string[] } | { kind: 'none' };

export function previewGridPrices(input: {
  lower: string;
  upper: string;
  count: number | null;
  tick: string;
  range: { min: number; max: number } | null;
}): GridPreview {
  const lower = dec(input.lower.trim() || null);
  const upper = dec(input.upper.trim() || null);
  const tick = dec(input.tick);
  const { count, range } = input;
  if (lower === null || upper === null || tick === null || tick <= 0n || count === null || range === null) return { kind: 'none' };
  if (!Number.isInteger(count) || count < range.min || count > range.max || count < 2 || !(lower > 0n && lower < upper))
    return { kind: 'none' };
  const steps = BigInt(count - 1);
  const prices: string[] = [];
  let previous: bigint | null = null;
  for (let i = 0; i < count; i += 1) {
    const raw = i === count - 1 ? upper : lower + ((upper - lower) * BigInt(i)) / steps;
    const price = (raw / tick) * tick;
    if (price <= 0n || (previous !== null && price <= previous)) return { kind: 'none' };
    previous = price;
    prices.push(str(price));
  }
  return { kind: 'levels', prices };
}

/** The grid count as typed: a whole number, or null when blank or not a whole number (the service then names the field). */
export function parseGridCount(text: string): number | null {
  const trimmed = text.trim();
  return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : null;
}
