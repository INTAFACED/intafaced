/**
 * The level plan for one spot grid (CB-bots-02). Pure and bigint only: nothing here reads or writes.
 *
 * `count` levels are spaced evenly from the lower bound to the upper bound inclusive, each price rounded down onto
 * the market's tick. The investment is split evenly: each level may use `investment / count` (floored to the
 * ledger's 18 places), and a level's buy quantity is the most whole lots that slice buys at that level's price. A
 * buy holds `ceil(price × qty)` in the quote asset (spot/risk.ts `holdFor`), which never exceeds its slice, so the
 * holds of every level together never exceed the investment the reserve records.
 */
import { div, mul, type Amount } from '@intafaced/ledger-client';
import { GridError } from './errors.js';
import { GRID_COUNT_FLOOR } from './policy.js';

export interface GridMarketFacts {
  readonly tickSize: Amount;
  readonly lotSize: Amount;
  readonly minQty: Amount;
  readonly minNotional: Amount;
  readonly maxQty: Amount | null;
}

export interface GridLevelPlan {
  readonly index: number;
  readonly price: Amount;
  /** The base quantity a buy at this level is for. */
  readonly qty: Amount;
  /** What that buy holds in the quote asset: ceil(price × qty). Never above `slice`. */
  readonly hold: Amount;
}

export interface GridPlan {
  readonly slice: Amount;
  readonly levels: readonly GridLevelPlan[];
}

export function floorTo(value: Amount, step: Amount): Amount {
  if (step <= 0n) return value;
  return (value / step) * step;
}

export function planGrid(input: {
  readonly lower: Amount;
  readonly upper: Amount;
  readonly count: number;
  readonly investment: Amount;
  readonly market: GridMarketFacts;
}): GridPlan {
  const { lower, upper, count, investment, market } = input;
  if (!(lower < upper)) {
    throw new GridError('Lower price must be below upper price', 'trade.grid_bounds_inverted');
  }
  if (!Number.isInteger(count) || count < GRID_COUNT_FLOOR) {
    throw new GridError(`Grids must be at least ${GRID_COUNT_FLOOR}`, 'trade.bots_grid_count_out_of_range');
  }
  const steps = BigInt(count - 1);
  const slice = investment / BigInt(count);
  const levels: GridLevelPlan[] = [];
  let previous: Amount | null = null;
  for (let i = 0; i < count; i += 1) {
    const raw = i === count - 1 ? upper : lower + ((upper - lower) * BigInt(i)) / steps;
    const price = floorTo(raw, market.tickSize);
    if (price <= 0n || (previous !== null && price <= previous)) {
      throw new GridError('Grids are closer together than the market tick allows', 'trade.grid_spacing_below_tick', {
        level: String(i),
      });
    }
    previous = price;
    let qty = floorTo(div(slice, price, 'floor'), market.lotSize);
    if (market.maxQty !== null && qty > market.maxQty) qty = floorTo(market.maxQty, market.lotSize);
    const hold = mul(price, qty, 'ceil');
    if (qty <= 0n || qty < market.minQty || hold < market.minNotional || hold > slice) {
      throw new GridError('Investment per grid is below the market minimum order', 'trade.grid_level_below_minimum', {
        level: String(i),
      });
    }
    levels.push({ index: i, price, qty, hold });
  }
  return { slice, levels };
}

/** Levels a fresh or resumed grid buys at: strictly below the mark. */
export function levelsBelowMark(levels: readonly GridLevelPlan[], mark: Amount): readonly GridLevelPlan[] {
  return levels.filter((level) => level.price < mark);
}

/** The range pause: the mark outside the bounds places no new buys. */
export function markInRange(lower: Amount, upper: Amount, mark: Amount): boolean {
  return mark >= lower && mark <= upper;
}
