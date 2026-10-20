/**
 * Spread book (CB-otc-16). Extends the combo-book idea from option combos to owner-listed spot and futures spreads.
 *
 * A spread is one instrument with its own OrderBook, keyed by the spread id. Spread orders rest and match there as
 * one order at a spread price; legs never rest on their own and never touch an outright book. This is the only book
 * for the spread: matching still holds every order book there is.
 *
 * Equal or nothing. A spread order is admitted only if every fill it would print can price every leg exactly at the
 * listed ratios (see `spread-instrument.ts` for the leg-price rule). The check rehearses the match on a copy of the
 * book first, so a refusal leaves the book, the sequence counter and the journal untouched, and no partial leg is
 * ever printed. Each accepted fill carries all of its legs, so the trade side can take one hold and post one fill per
 * spread fill.
 *
 * Scope: GTC limit only. IOC, FOK and post-only on spreads are CB-otc-17 and refuse `spread_order_unsupported` until
 * then. Native amend refuses `spread_amend_unsupported`; cancel works through the normal cancel door.
 *
 * Hitch, like combo-book: wraps OrderBook.submit/amend so journal replay, which builds plain OrderBooks, gets the same
 * behaviour as the live engine. The MatchingEngine constructor installs it (idempotent); without it the core book
 * refuses every spread order rather than matching one without its legs. The book mark lives in a WeakMap, so a book restored from a snapshot (not a replay)
 * is unmarked and fails closed: spread orders on it refuse `spread_book_outright_refused`.
 */
import { ZERO, formatAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { spreadIdentity, spreadLegFills, spreadLegPrices, spreadReferenceRefuse } from './spread-instrument.js';
import type { AmendResult, EngineAmend, EngineOrder, Fill, MarketId, RejectReason, SubmitResult } from './types.js';

const FLAG = Symbol.for('intafaced.matching.spread-book');

type BookSubmit = (this: OrderBook, order: EngineOrder, now?: Date | null) => SubmitResult;
type BookAmend = (this: OrderBook, cmd: EngineAmend, now?: Date | null) => AmendResult;

/** Book -> identity of the spread listing it trades. Set on the first accepted spread order. */
const marked = new WeakMap<OrderBook, string>();

/** The submit this hitch wrapped. The rehearsal runs it on a copy so it cannot recurse into this hitch. */
let innerSubmit: BookSubmit | null = null;

/** The only order fields a spread order may carry. Anything else set is a feature spreads do not have yet. */
const SPREAD_ORDER_FIELDS = new Set<string>([
  'orderId',
  'accountId',
  'type',
  'side',
  'qty',
  'price',
  'stopPrice',
  'tif',
  'clientOrderId',
  'environment',
  'sessionId',
  'spread',
]);

function refuse(code: RejectReason['code'], message: string): RejectReason {
  return { code, message };
}

function rejected(reason: RejectReason): SubmitResult {
  return { accepted: false, sequence: null, fills: [], resting: null, rejected: reason, cancellations: [], triggered: [] };
}

function amendRefused(orderId: string): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: refuse('spread_amend_unsupported', 'a spread order does not amend in place; cancel it and place a new one'),
    cancellations: [],
    triggered: [],
  };
}

export function outrightOnSpreadRefuse(marketId: MarketId): RejectReason {
  return refuse('spread_book_outright_refused', `${marketId} is a spread book; it takes spread orders only`);
}

/** True when this book has accepted a spread order. */
export function isSpreadBook(book: OrderBook | null | undefined): boolean {
  return book != null && marked.has(book);
}

function unsupportedField(order: EngineOrder): string | null {
  for (const [key, value] of Object.entries(order)) {
    if (SPREAD_ORDER_FIELDS.has(key)) continue;
    if (value === undefined || value === null || value === false) continue;
    return key;
  }
  return null;
}

/**
 * Why this spread order must not be admitted to `book`, or null. Pure: it reads the book and rehearses on a copy.
 * The engine calls it before journalling; the book hitch calls it again so replay reaches the same answer.
 */
export function spreadOrderRefuse(book: OrderBook | null, marketId: MarketId, order: EngineOrder, now?: Date | null): RejectReason | null {
  const terms = order.spread;
  if (terms == null) return null;
  const instrument = terms.instrument;
  if (instrument.spreadId !== marketId) {
    return refuse('spread_identity_disagrees', `a ${instrument.spreadId} spread order cannot rest in ${marketId}`);
  }
  if (book !== null) {
    const mark = marked.get(book);
    if (mark !== undefined && mark !== spreadIdentity(instrument)) {
      return refuse('spread_identity_disagrees', `${marketId} trades a different listing of this spread`);
    }
    if (mark === undefined && book.currentSequence > 0) return outrightOnSpreadRefuse(marketId);
  }

  if (order.type !== 'limit' || order.price === null || order.stopPrice !== null) {
    return refuse('spread_order_unsupported', 'a spread order is a limit order at a spread price');
  }
  if (order.tif !== 'GTC') {
    return refuse('spread_order_unsupported', `spread time-in-force ${order.tif} is not built yet (CB-otc-17); GTC only`);
  }
  const extra = unsupportedField(order);
  if (extra !== null) return refuse('spread_order_unsupported', `spread orders do not take ${extra}`);

  // Non-positive qty is the core book's invalid_qty, not a lot question.
  if (order.qty <= ZERO) return null;
  if (order.qty % instrument.lot !== ZERO) {
    return refuse('spread_qty_off_lot', 'spread qty is not a whole number of lots');
  }
  if (order.price % instrument.tick !== ZERO) {
    return refuse('spread_price_off_tick', 'spread price is not on the listed tick');
  }
  const reference = terms.anchorReference;
  const missing = spreadReferenceRefuse(instrument, reference);
  if (missing) return missing;

  // The order's own price must price every leg, or a rest could block every later taker.
  const own = spreadLegPrices(instrument, reference as bigint, order.price);
  if (!own.ok) return own.rejected;

  if (book === null || innerSubmit === null) return null;
  const rehearsal = innerSubmit.call(book.clone(), order, now);
  if (!rehearsal.accepted) return null;
  for (const fill of rehearsal.fills) {
    const legs = spreadLegFills(instrument, reference as bigint, fill.price, fill.qty, fill.takerSide);
    if (!legs.ok) return legs.rejected;
  }
  return null;
}

function withLegs(result: SubmitResult, order: EngineOrder): SubmitResult {
  const terms = order.spread;
  if (terms == null || result.fills.length === 0) return result;
  const reference = terms.anchorReference as bigint;
  const fills: Fill[] = result.fills.map((fill) => {
    const legs = spreadLegFills(terms.instrument, reference, fill.price, fill.qty, fill.takerSide);
    // The rehearsal priced these exact fills. Reaching here means the book moved under it — never print half a spread.
    if (!legs.ok) throw new Error(`spread leg invariant broken on ${fill.sequence}: ${legs.rejected.message}`);
    return { ...fill, legs: legs.legs };
  });
  return { ...result, fills };
}

/**
 * One spread fill as the engine announces it: the spread print plus every leg, so the trade side posts one hold and
 * one fill per spread fill. Decimal strings only; `price` may be zero or negative.
 */
export interface SpreadFillEvent {
  readonly spreadId: MarketId;
  readonly makerOrderId: string;
  readonly takerOrderId: string;
  readonly makerAccountId: string;
  readonly takerAccountId: string;
  readonly takerSide: 'buy' | 'sell';
  readonly price: string;
  readonly qty: string;
  readonly sequence: number;
  readonly ts: string;
  readonly legs: readonly { readonly symbol: string; readonly takerSide: 'buy' | 'sell'; readonly qty: string; readonly price: string }[];
}

/**
 * Where spread fills go: production publishes them on `matching.spread.filled` (`spread-fill-publisher.ts`). An engine
 * built without one refuses spread orders `spread_fill_event_unwired` before they are journalled: a maker fill nobody
 * announces would strand that maker's hold.
 */
export interface SpreadFillPublisher {
  publish(event: SpreadFillEvent, opts: { readonly idempotencyKey: string }): Promise<unknown> | unknown;
}

export function spreadFillEvent(spreadId: MarketId, fill: Fill, at: string): SpreadFillEvent {
  return {
    spreadId,
    makerOrderId: fill.makerOrderId,
    takerOrderId: fill.takerOrderId,
    makerAccountId: fill.makerAccountId,
    takerAccountId: fill.takerAccountId,
    takerSide: fill.takerSide,
    price: formatAmount(fill.price),
    qty: formatAmount(fill.qty),
    sequence: fill.sequence,
    ts: at,
    legs: (fill.legs ?? []).map((leg) => ({
      symbol: leg.symbol,
      takerSide: leg.takerSide,
      qty: formatAmount(leg.qty),
      price: formatAmount(leg.price),
    })),
  };
}

/** Business key: one spread fill has one engine sequence on its book, forever. */
export function spreadFillKey(spreadId: MarketId, sequence: number): string {
  return `matching.spread.filled:${spreadId}:${sequence}`;
}

export function installSpreadBook(ctor: typeof OrderBook = OrderBook): void {
  const proto = ctor.prototype as unknown as {
    submit: BookSubmit;
    amend: BookAmend;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origSubmit = proto.submit;
  const origAmend = proto.amend;
  innerSubmit = origSubmit;

  proto.submit = function (this: OrderBook, order: EngineOrder, now?: Date | null) {
    if (order.spread == null) {
      if (marked.has(this)) return rejected(outrightOnSpreadRefuse(this.marketId));
      return origSubmit.call(this, order, now);
    }
    // A retry of an accepted id gets the core duplicate_order_id answer, not a second rehearsal.
    if (this.hasAccepted(order.orderId)) return origSubmit.call(this, order, now);
    const refusal = spreadOrderRefuse(this, this.marketId, order, now);
    if (refusal) return rejected(refusal);
    const result = origSubmit.call(this, order, now);
    if (!result.accepted) return result;
    marked.set(this, spreadIdentity(order.spread.instrument));
    return withLegs(result, order);
  };

  proto.amend = function (this: OrderBook, cmd: EngineAmend, now?: Date | null) {
    if (marked.has(this)) return amendRefused(cmd.orderId);
    return origAmend.call(this, cmd, now);
  };
}
