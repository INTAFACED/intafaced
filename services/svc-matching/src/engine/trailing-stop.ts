/**
 * Trailing stop through matching. The stop walks with the mark.
 * Trail and peak ride the book snapshot. Refuse if trail is missing.
 * The engine does not invent a mark.
 */
import { ZERO, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import './option.js';
import './oco-link.js';
import './oco-cancel.js';
import './bracket.js';
import type { EngineOrder, OrderSide, SubmitResult } from './types.js';

export const TRAIL_MISSING = 'missing_trail' as const;
export const MARK_MISSING = 'missing_mark' as const;

export type TrailingRefuse = typeof TRAIL_MISSING | typeof MARK_MISSING;

const FLAG = Symbol.for('intafaced.matching.trailingStop');

type TrailLive = { readonly side: OrderSide; readonly trail: Amount; peak: Amount };
const live = new WeakMap<OrderBook, Map<string, TrailLive>>();

export function wantsTrailing(order: { readonly type?: string; readonly trail?: Amount | null }): boolean {
  return order.trail !== undefined;
}

/** Caller trail. Null/zero is missing — never invent a distance. */
export function readTrail(order: { readonly trail?: Amount | null }): Amount | null {
  if (order.trail !== undefined) return order.trail;
  return null;
}

/** Caller mark. Null/zero is missing — never invent a mark from last, mid, or best. */
export function readMark(order: { readonly mark?: Amount | null }): Amount | null {
  if (order.mark !== undefined) return order.mark;
  return null;
}

export function trailRefuse(trail: Amount | null): { readonly code: typeof TRAIL_MISSING; readonly message: string } | null {
  if (trail === null || trail <= ZERO) {
    return {
      code: TRAIL_MISSING,
      message: 'a trailing stop requires a trail; the engine does not invent a distance',
    };
  }
  return null;
}

export function markRefuse(mark: Amount | null): { readonly code: typeof MARK_MISSING; readonly message: string } | null {
  if (mark === null || mark <= ZERO) {
    return {
      code: MARK_MISSING,
      message: 'a trailing stop walks with the mark; the engine does not invent a mark',
    };
  }
  return null;
}

/**
 * Extreme the trail follows. Sell tracks the high; buy tracks the low.
 * A worse mark does not walk the stop back.
 */
export function ratchetPeak(side: OrderSide, peak: Amount | null, mark: Amount): Amount {
  if (peak === null) return mark;
  return side === 'sell' ? (mark > peak ? mark : peak) : mark < peak ? mark : peak;
}

/**
 * Trigger from the extreme and the trail. Sell is extreme minus trail.
 * Buy is extreme plus trail. Never invent a mark to fill either side.
 */
export function walkStop(side: OrderSide, extreme: Amount, trail: Amount): Amount | null {
  if (side === 'sell') {
    if (extreme <= trail) return null;
    return extreme - trail;
  }
  return extreme + trail;
}

function rejected(
  code: SubmitResult['rejected'] extends infer R ? (R extends { code: infer C } ? C : never) : never,
  message: string,
): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code, message },
    cancellations: [],
    triggered: [],
  };
}

function remember(book: OrderBook, orderId: string, rec: TrailLive): void {
  let rows = live.get(book);
  if (!rows) {
    rows = new Map();
    live.set(book, rows);
  }
  rows.set(orderId, rec);
}

/** Sell tightens by raising the trigger. Buy tightens by lowering it. */
function triggerTightened(side: OrderSide, next: Amount, current: Amount): boolean {
  return side === 'sell' ? next > current : next < current;
}

/**
 * Live rows for this book. A restored book has an empty map, so the rows are
 * rebuilt from resting stops that already carry a trail and a peak.
 * A missing trail or a missing peak is not a trailing stop — never invented.
 */
function rowsFor(book: OrderBook): Map<string, TrailLive> {
  let rows = live.get(book);
  if (!rows) {
    rows = new Map();
    live.set(book, rows);
  }
  for (const stop of book.toState().stops) {
    if (rows.has(stop.orderId)) continue;
    if (stop.trail == null || stop.peak == null) continue;
    const trail = parseAmount(stop.trail);
    const peak = parseAmount(stop.peak);
    if (trail <= ZERO || peak <= ZERO) continue;
    rows.set(stop.orderId, { side: stop.side, trail, peak });
  }
  return rows;
}

/**
 * Injected mark. Walks every live trailing stop on this book. Never invents one.
 * The peak only ratchets and the trigger only tightens, so a repeated or older mark changes nothing.
 * `changed` is true only when a peak or a trigger moved.
 */
export function applyMark(
  book: OrderBook,
  mark: Amount | null,
): { readonly refused: { readonly code: TrailingRefuse; readonly message: string } | null; readonly changed: boolean } {
  const refuse = markRefuse(mark);
  if (refuse) return { refused: refuse, changed: false };
  if (mark === null) return { refused: null, changed: false };
  let changed = false;
  const rows = rowsFor(book);
  const state = book.toState();
  for (const [orderId, rec] of rows) {
    const stop = state.stops.find((s) => s.orderId === orderId);
    if (!stop) {
      rows.delete(orderId);
      continue;
    }
    const side = stop.side;
    const peak = ratchetPeak(side, rec.peak, mark);
    const next = walkStop(side, peak, rec.trail);
    if (next === null || next <= ZERO) continue;
    const current = parseAmount(stop.stopPrice);
    if (!triggerTightened(side, next, current)) {
      if (peak !== rec.peak && book.noteStopPeak(orderId, peak)) {
        rec.peak = peak;
        changed = true;
      }
      continue;
    }
    const amended = book.amend({
      orderId,
      expectedVersion: stop.version && stop.version > 0 ? stop.version : 1,
      stopPrice: next,
    });
    if (!amended.accepted) continue;
    if (!book.noteStopPeak(orderId, peak)) {
      rows.delete(orderId);
      continue;
    }
    rec.peak = peak;
    changed = true;
  }
  return { refused: null, changed };
}

export function installTrailingStop(ctor: typeof OrderBook): void {
  if (!ctor) return;
  const proto = ctor.prototype as {
    submit: (order: EngineOrder, now?: Date | null) => SubmitResult;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const orig = proto.submit;
  proto.submit = function (this: OrderBook, order: EngineOrder, now?: Date | null) {
    if (!wantsTrailing(order)) return orig.call(this, order, now);
    const trail = readTrail(order);
    const missingTrail = trailRefuse(trail);
    if (missingTrail) return rejected(missingTrail.code, missingTrail.message);
    const mark = readMark(order);
    const missingMark = markRefuse(mark);
    if (missingMark) return rejected(missingMark.code, missingMark.message);
    const stopPrice = walkStop(order.side, mark as Amount, trail as Amount);
    if (stopPrice === null || stopPrice <= ZERO) {
      return rejected('invalid_price', 'trailing stop would not be a positive trigger; the engine does not invent a mark');
    }
    const result = orig.call(
      this,
      {
        ...order,
        type: 'stop',
        price: null,
        stopPrice,
      },
      now,
    );
    if (result.accepted) {
      remember(this, order.orderId, { side: order.side, trail: trail as Amount, peak: mark as Amount });
    }
    return result;
  };
}

installTrailingStop(OrderBook);
