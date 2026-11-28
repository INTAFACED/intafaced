import { div, mul } from '@intafaced/money-math';
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

type RiskSizeRefusal =
  | { readonly reason: 'no_risk' | 'no_entry' | 'no_stop' | 'fee_unpublished' }
  /** The stop sits on the wrong side of the mark (or of the entry): a long's below both, a short's above both. */
  | { readonly reason: 'stop_wrong_side'; readonly against: 'mark' | 'entry'; readonly price: string }
  /** The size worked out is under the venue's smallest order: one lot, or its published smallest order value. */
  | {
      readonly reason: 'below_minimum';
      readonly size: string;
      readonly minSize: string;
      readonly minNotional: string | null;
      /** What the smallest order the venue takes would lose at this stop, fees both ways. */
      readonly minLoss: string;
    };

export type RiskSize =
  { readonly ok: true; readonly size: string; readonly lossAtStop: string } | ({ readonly ok: false } & RiskSizeRefusal);

/** The fee rates in basis points the size is worked out with; null is not published. */
export interface RiskFees {
  /** The venue's rate on the way in: the higher of its maker and taker rates, since a limit may fill either way. */
  readonly venueInBps: string | null;
  /** The venue's rate on the way out: its taker rate, since a stop fills at market. */
  readonly venueOutBps: string | null;
  /** Our builder fee, charged on the way in and on the way out. */
  readonly builderBps: string | null;
}

const BPS = SCALE * 10_000n;

/** `price` × `bps` / 10 000, rounded up: a fee per unit, never understated. */
const feeAt = (price: Scaled, bps: Scaled): Scaled => div(mul(price, bps, 'ceil'), BPS, 'ceil');

/** The smallest whole number of lots at or above `value`. */
const ceilLots = (value: Scaled, lot: Scaled): Scaled => {
  const lots = div(value, lot, 'ceil');
  const whole = lots / SCALE + (lots % SCALE === ZERO ? 0n : 1n);
  return whole * lot;
};

/**
 * Desk B's "size from my risk", in desk A's ticket (J-derivatives-34 #1 #2): the size that loses no more than `risk` (in
 * the quote asset) if the stop fills, after the venue's fee and our builder fee on the way in and on the way out, rounded
 * down to the market's lot. Per unit, a stop-out loses the distance from entry to stop plus each fee at its price:
 * entry × (venue in + builder) and stop × (venue out + builder), each rounded up. A long's stop sits below the mark and
 * the entry, a short's above both. A size under the venue's smallest order (one lot, or its published smallest order
 * value at the entry) is refused naming the size it would need. Nothing is guessed: an unpublished fee refuses.
 */
export function sizeFromRisk(input: {
  risk: string;
  entry: string | null;
  stop: string;
  mark: string | null;
  lot: string;
  side: 'buy' | 'sell';
  fees: RiskFees;
  minNotional: string | null;
}): RiskSize {
  const risk = dec(input.risk.trim());
  if (risk === null || risk <= ZERO) return { ok: false, reason: 'no_risk' };
  const entry = dec(input.entry);
  if (entry === null || entry <= ZERO) return { ok: false, reason: 'no_entry' };
  const stop = dec(input.stop.trim());
  if (stop === null || stop <= ZERO) return { ok: false, reason: 'no_stop' };
  const lot = dec(input.lot);
  if (lot === null || lot <= ZERO) return { ok: false, reason: 'no_entry' };
  const long = input.side === 'buy';
  const wrong = (ref: Scaled) => (long ? stop >= ref : stop <= ref);
  const mark = dec(input.mark);
  if (mark !== null && mark > ZERO && wrong(mark)) return { ok: false, reason: 'stop_wrong_side', against: 'mark', price: str(mark) };
  if (wrong(entry)) return { ok: false, reason: 'stop_wrong_side', against: 'entry', price: str(entry) };
  const venueIn = dec(input.fees.venueInBps);
  const venueOut = dec(input.fees.venueOutBps);
  const builder = dec(input.fees.builderBps);
  if (venueIn === null || venueOut === null || builder === null) return { ok: false, reason: 'fee_unpublished' };
  const distance = long ? sub(entry, stop) : sub(stop, entry);
  const perUnit = add(add(distance, feeAt(entry, add(venueIn, builder))), feeAt(stop, add(venueOut, builder)));
  const lots = div(div(risk, perUnit, 'floor'), lot, 'floor') / SCALE; // whole lots: SCALE is one unit, so this drops the fraction
  const size = lots * lot;
  const minNotional = dec(input.minNotional);
  const byValue = minNotional !== null && minNotional > ZERO ? ceilLots(div(minNotional, entry, 'ceil'), lot) : ZERO;
  const minSize = byValue > lot ? byValue : lot;
  if (size < minSize)
    return {
      ok: false,
      reason: 'below_minimum',
      size: str(size),
      minSize: str(minSize),
      minNotional: minNotional === null ? null : str(minNotional),
      minLoss: str(mul(minSize, perUnit, 'ceil')),
    };
  return { ok: true, size: str(size), lossAtStop: str(mul(size, perUnit, 'ceil')) };
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
