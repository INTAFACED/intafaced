import { SCALE, add, dec, ratio, str, sub, times, toFixedString, ZERO, type Scaled } from '../../../data/decimal';
import type { VenueFill, VenueMarket, VenuePosition } from '../venue-api';

// The positions room's figures (J-derivatives-05 #1 #2), every one from the venue's own position and fills, as exact
// decimals: nothing here turns money into a JS number. A figure the venue does not publish is `null`, never 0.

const num = (value: string): Scaled => dec(value) ?? ZERO;

/** One position row's notional at the venue's mark: size × mark. */
export function notional(p: VenuePosition): string {
  return str(times(num(p.size), num(p.markPrice)));
}

export interface PositionTotals {
  readonly count: number;
  readonly notional: string;
  readonly margin: string;
  readonly unrealisedPnl: string;
}

/** The totals row: each column the sum of the rows above it, to the last digit. */
export function totalsOf(rows: readonly VenuePosition[]): PositionTotals {
  let n = ZERO;
  let m = ZERO;
  let u = ZERO;
  for (const p of rows) {
    n = add(n, times(num(p.size), num(p.markPrice)));
    m = add(m, num(p.margin));
    u = add(u, num(p.unrealisedPnl));
  }
  return { count: rows.length, notional: str(n), margin: str(m), unrealisedPnl: str(u) };
}

/**
 * The fees the position paid opening, from the venue's own fills on its market (venue fee and our builder fee): walked
 * oldest first since the position was last flat. A part close keeps the remaining size's share of them; a full close
 * starts again from nothing.
 */
export function openingFees(p: VenuePosition, fills: readonly VenueFill[]): string {
  const mine = fills
    .filter((f) => f.symbol === p.symbol)
    .slice()
    .sort((a, b) => a.filledAt.localeCompare(b.filledAt));
  let size = ZERO;
  let fees = ZERO;
  for (const f of mine) {
    const amount = num(f.amount);
    const paid = add(num(f.venueFee), num(f.builderFee));
    if (f.realisedPnl === null) {
      size = add(size, amount);
      fees = add(fees, paid);
      continue;
    }
    const left = sub(size, amount);
    if (left <= ZERO) {
      size = ZERO;
      fees = ZERO;
      continue;
    }
    fees = ratio(times(fees, left), size) ?? ZERO;
    size = left;
  }
  return str(fees);
}

/**
 * Break-even: the price at which closing gives back what opening cost: entry plus the opening fees per unit for a long,
 * minus them for a short. Exact to the last digit (18 places at most).
 */
export function breakEven(p: VenuePosition, fills: readonly VenueFill[]): string {
  const perUnit = ratio(num(openingFees(p, fills)), num(p.size)) ?? ZERO;
  return str(p.side === 'long' ? add(num(p.entryPrice), perUnit) : sub(num(p.entryPrice), perUnit));
}

/**
 * The margin ratio: the venue's maintenance margin over the position's equity (its margin plus its unrealised result),
 * as a percentage to two places; `null` where the venue publishes no maintenance margin; `'liquidation'` at or below
 * zero equity.
 */
export function marginRatio(p: VenuePosition): string | null | 'liquidation' {
  if (!p.maintenanceMargin?.known) return null;
  const equity = add(num(p.margin), num(p.unrealisedPnl));
  if (equity <= ZERO) return 'liquidation';
  const r = ratio(times(num(p.maintenanceMargin.value), 100n * SCALE), equity) ?? ZERO;
  return toFixedString(r, 2);
}

/** The P&L formula the venue's figure follows, with this position's own numbers in it. */
export function pnlFormula(p: VenuePosition): { words: 'long' | 'short'; mark: string; entry: string; size: string; result: string } {
  const diff = p.side === 'long' ? sub(num(p.markPrice), num(p.entryPrice)) : sub(num(p.entryPrice), num(p.markPrice));
  return { words: p.side, mark: p.markPrice, entry: p.entryPrice, size: p.size, result: str(times(diff, num(p.size))) };
}

/** The product a position is in, from its market's own listing: a stock perpetual, or a perpetual. */
export function productOf(market: VenueMarket | undefined): 'stock_perpetual' | 'perpetual' | 'unknown' {
  if (!market) return 'unknown';
  if (market.kind !== 'perpetual') return 'unknown';
  return market.session.known ? 'stock_perpetual' : 'perpetual';
}

/** A leverage in times as typed ("15"), as basis points of 1x; null when it is not a whole number of at least 1. */
export function leverageBpsOfTimes(text: string): number | null {
  const t = text.trim();
  if (!/^[1-9]\d{0,3}$/.test(t)) return null;
  return Number(t) * 10_000;
}
