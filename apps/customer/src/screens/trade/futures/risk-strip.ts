import { div } from '@intafaced/money-math';
import { add, dec, SCALE, str, sub, times, ZERO, type Scaled } from '../../../data/decimal';
import type { VenueOrder, VenuePosition } from '../../../features/trade/venue-api';

// Desk A's risk strip: what the open positions make or lose now, and if every stop or every target on them fills at its
// trigger. Exact decimals from the venue's own positions and resting trigger orders; before fees, and said so. A
// position with no stop (or no target) resting is counted, never priced as zero.

export interface RiskTotals {
  readonly open: string;
  readonly ifStops: string;
  readonly ifTargets: string;
  /** Positions with no stop resting, and with no target resting. */
  readonly noStop: number;
  readonly noTarget: number;
  readonly count: number;
}

const num = (value: string): Scaled => dec(value) ?? ZERO;

/** A resting reduce-only trigger that closes this position: the side against it, on its market. */
function closes(order: VenueOrder, p: VenuePosition): boolean {
  const against = p.side === 'long' ? 'sell' : 'buy';
  return order.symbol === p.symbol && order.side === against && order.reduceOnly && order.trigger?.state === 'waiting';
}

const isStop = (o: VenueOrder) => /stop/.test(o.trigger?.role ?? o.type);
const isTarget = (o: VenueOrder) => /take_profit|target/.test(o.trigger?.role ?? o.type);

/** The position's result if it closed whole at `price`: (price − entry) × size, signed by its side. */
function resultAt(p: VenuePosition, price: Scaled): Scaled {
  const move = sub(price, num(p.entryPrice));
  const made = times(move, num(p.size));
  return p.side === 'long' ? made : -made;
}

export function riskOf(positions: readonly VenuePosition[], orders: readonly VenueOrder[]): RiskTotals {
  let open = ZERO;
  let ifStops = ZERO;
  let ifTargets = ZERO;
  let noStop = 0;
  let noTarget = 0;
  for (const p of positions) {
    open = add(open, num(p.unrealisedPnl));
    const mine = orders.filter((o) => closes(o, p));
    const stop = mine.find(isStop);
    const target = mine.find(isTarget);
    // No stop: the position stays open at its mark, so it adds what it shows now; the count says it is unprotected.
    if (stop?.trigger) ifStops = add(ifStops, resultAt(p, num(stop.trigger.price)));
    else {
      noStop += 1;
      ifStops = add(ifStops, num(p.unrealisedPnl));
    }
    if (target?.trigger) ifTargets = add(ifTargets, resultAt(p, num(target.trigger.price)));
    else {
      noTarget += 1;
      ifTargets = add(ifTargets, num(p.unrealisedPnl));
    }
  }
  return { open: str(open), ifStops: str(ifStops), ifTargets: str(ifTargets), noStop, noTarget, count: positions.length };
}

export type RiskSize =
  | { readonly ok: true; readonly size: string }
  | { readonly ok: false; readonly reason: 'no_risk' | 'no_entry' | 'no_stop' | 'stop_wrong_side' | 'below_lot' };

/**
 * Desk B's "size from my risk", in desk A's ticket: the size that loses `risk` (in the quote asset) if the stop fills,
 * rounded down to the market's lot, so the loss at the stop is never more than the person typed. Before fees.
 */
export function sizeFromRisk(input: { risk: string; entry: string | null; stop: string; lot: string; side: 'buy' | 'sell' }): RiskSize {
  const risk = dec(input.risk.trim());
  if (risk === null || risk <= ZERO) return { ok: false, reason: 'no_risk' };
  const entry = dec(input.entry);
  if (entry === null || entry <= ZERO) return { ok: false, reason: 'no_entry' };
  const stop = dec(input.stop.trim());
  if (stop === null || stop <= ZERO) return { ok: false, reason: 'no_stop' };
  // A long's stop sits below its entry, a short's above.
  const distance = input.side === 'buy' ? sub(entry, stop) : sub(stop, entry);
  if (distance <= ZERO) return { ok: false, reason: 'stop_wrong_side' };
  const lot = dec(input.lot);
  if (lot === null || lot <= ZERO) return { ok: false, reason: 'no_entry' };
  const lots = div(div(risk, distance, 'floor'), lot, 'floor') / SCALE; // whole lots: SCALE is one unit, so this drops the fraction
  if (lots <= ZERO) return { ok: false, reason: 'below_lot' };
  return { ok: true, size: str(lots * lot) };
}

/** One chart line's figures: where it sits, what it would make or lose there (null for the entry and liquidation). */
export interface PositionLine {
  readonly kind: 'entry' | 'stop' | 'target' | 'liquidation';
  readonly price: string;
  readonly result: string | null;
}

/**
 * Desk A's lines on the chart for one market's position: its entry (with the open result), its resting stop and target
 * (with what each would make or lose, before fees) and the venue's estimated liquidation, where it publishes one.
 */
export function positionLines(position: VenuePosition | undefined, orders: readonly VenueOrder[]): PositionLine[] {
  if (!position) return [];
  const lines: PositionLine[] = [{ kind: 'entry', price: position.entryPrice, result: position.unrealisedPnl }];
  const mine = orders.filter((o) => closes(o, position));
  const stop = mine.find(isStop)?.trigger;
  const target = mine.find(isTarget)?.trigger;
  if (stop) lines.push({ kind: 'stop', price: stop.price, result: str(resultAt(position, num(stop.price))) });
  if (target) lines.push({ kind: 'target', price: target.price, result: str(resultAt(position, num(target.price))) });
  if (position.liquidationPrice.known) lines.push({ kind: 'liquidation', price: position.liquidationPrice.value, result: null });
  return lines;
}
