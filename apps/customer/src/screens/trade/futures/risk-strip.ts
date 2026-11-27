import { div } from '@intafaced/money-math';
import { add, dec, SCALE, str, sub, times, ZERO, type Scaled } from '../../../data/decimal';
import type { VenueOrder, VenuePosition } from '../../../features/trade/venue-api';

// Desk A's risk strip: what the open positions make or lose now, and if every stop or every target on them fills at its
// trigger, after the venue's fee and ours in and out (J-derivatives-32 #1). Exact decimals from the venue's own
// positions, fills and resting trigger orders. A position with no stop resting is named in place of a loss total.

export interface RiskTotals {
  /** The venue's own open result on every position, as it reports it. */
  readonly open: string;
  /**
   * What every stop would make or lose if it filled at its trigger, after the venue's fee and ours in and out; null when
   * a position has no stop (named in `noStop`) or a figure it rests on is not known (`feesUnknown`).
   */
  readonly ifStops: string | null;
  /** The same for every target resting; null when none rests or a figure is not known. */
  readonly ifTargets: string | null;
  /** The markets of the positions with no stop resting, and with no target resting. */
  readonly noStop: readonly string[];
  readonly noTarget: readonly string[];
  /** True when the venue's fee, our fee or a position's opening fees are not known, so no total after fees is shown. */
  readonly feesUnknown: boolean;
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

/** What closing the whole position at a price nets after fees (`exit-figures.ts` netAt); null when not known. */
export type NetAt = (position: VenuePosition, price: string) => string | null;

export function riskOf(positions: readonly VenuePosition[], orders: readonly VenueOrder[], netAt: NetAt): RiskTotals {
  let open = ZERO;
  let ifStops: Scaled | null = ZERO;
  let ifTargets: Scaled | null = ZERO;
  let anyTarget = false;
  let feesUnknown = false;
  const noStop: string[] = [];
  const noTarget: string[] = [];
  const at = (p: VenuePosition, price: string): Scaled | null => {
    const v = dec(netAt(p, price));
    if (v === null) feesUnknown = true;
    return v;
  };
  for (const p of positions) {
    open = add(open, num(p.unrealisedPnl));
    const mine = orders.filter((o) => closes(o, p));
    const stop = mine.find(isStop);
    const target = mine.find(isTarget);
    // No stop: there is no loss total to give, only the position named, so a total never looks safer than it is.
    if (stop?.trigger) {
      const v = at(p, stop.trigger.price);
      ifStops = ifStops === null || v === null ? null : add(ifStops, v);
    } else noStop.push(p.symbol);
    if (target?.trigger) {
      anyTarget = true;
      const v = at(p, target.trigger.price);
      ifTargets = ifTargets === null || v === null ? null : add(ifTargets, v);
    } else noTarget.push(p.symbol);
  }
  return {
    open: str(open),
    ifStops: noStop.length > 0 || ifStops === null ? null : str(ifStops),
    ifTargets: !anyTarget || ifTargets === null ? null : str(ifTargets),
    noStop,
    noTarget,
    feesUnknown,
    count: positions.length,
  };
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
