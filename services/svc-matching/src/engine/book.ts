import { ZERO, formatAmount, min, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type {
  AccountId,
  AmendResult,
  BookState,
  CancelReason,
  CancelResult,
  CancelledRef,
  EngineAmend,
  EngineOrder,
  EngineSurveillanceCase,
  Fill,
  MarketId,
  OrderId,
  OrderSide,
  PriceLevelState,
  RejectReason,
  RestingRef,
  SubmitResult,
  TimeInForce,
  TriggerFact,
  TriggerOutcome,
} from './types.js';
import { aonIcebergRefuse, canFillAon, clipMeetsAon, readAon } from './aon.js';
import { ownedOrderIds, readSessionId } from './mass-cancel.js';
import { sessionOrderIds } from './session.js';
import { icebergDisplayRefuse, refillDisplay, visibleRemaining, wantsIceberg } from './iceberg.js';
import { bothSidesMeetMinQty, minQtyRefuse, readMinQty } from './min-qty.js';
import { auctionIntentRefuse } from './auction.js';
import { collarIntentRefuse } from './collar.js';
import { minNotionalIntentRefuse } from './min-notional.js';
import { bindPegRelative, pegIntentRefuse } from './peg.js';
import { isSelfTrade, selfTradeExpire, selfTradeSurveillanceCase, stpIdentityPresent, stpIdentityRefuse } from './self-trade.js';

/**
 * THE ORDER BOOK (§5.1).
 *
 * "In-memory books per market: price-time priority, limit/market/stop,
 *  post-only, IOC/FOK … Deterministic, event-sourced, replayable."
 *
 * This file is pure. No I/O, no async, no clock, no randomness, and nothing
 * that iterates an unordered collection in a way that reaches the output. That
 * is not stylistic: §5.4 requires that replaying the journal twice produces
 * byte-identical state, and every one of those would break it.
 *
 * Specifically forbidden in here, forever:
 *   - `Date.now()` / `new Date()` — time enters via the journal, never the book
 *   - `Math.random()` / `crypto.randomUUID()` — ids come from the caller
 *   - a JS `number` holding a price or a quantity — prices and quantities are
 *     `Amount`, the scaled bigint from `@intafaced/ledger-client`
 *
 * The only `number` in the whole file is `sequence`, a monotonic counter.
 */

interface RestingOrder {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly side: OrderSide;
  readonly price: Amount;
  remaining: Amount;
  /** Acceptance sequence — the "time" in price-time priority. */
  readonly sequence: number;
  /** Instruction version. Bumps on amend; queue `sequence` does not have to. */
  version: number;
  ocoSiblingId: OrderId | null;
  expireAt: string | null;
  sessionId: string | null;
  reduceOnly: boolean;
  /** Resting post-only. A later amend must not take. */
  postOnly: boolean;
  displayPeak: Amount | null;
  displayRemaining: Amount | null;
  minQty: Amount | null;
  aon: boolean;
}

interface PriceLevel {
  readonly price: Amount;
  /** FIFO. Index 0 is the oldest order at this price and fills first. */
  readonly orders: RestingOrder[];
}

interface StopOrder {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly type: 'stop' | 'stop_limit';
  readonly side: OrderSide;
  qty: Amount;
  readonly price: Amount | null;
  readonly stopPrice: Amount;
  readonly tif: TimeInForce;
  readonly sequence: number;
  version: number;
  ocoSiblingId: OrderId | null;
  expireAt: string | null;
  sessionId: string | null;
  reduceOnly: boolean;
  triggerBy: 'last' | 'mark' | 'index';
  triggerRole: 'legacy' | 'take_profit' | 'stop_loss';
  minQty: Amount | null;
  aon: boolean;
  /** Trail distance. Null when this stop does not walk. */
  trail: Amount | null;
  /** Extreme the trail follows. Null when this stop does not walk. */
  peak: Amount | null;
}

interface EffectiveOrder {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly side: OrderSide;
  readonly qty: Amount;
  readonly price: Amount | null;
  readonly tif: TimeInForce;
  readonly ocoSiblingId: OrderId | null;
  readonly expireAt: string | null;
  readonly sessionId: string | null;
  readonly reduceOnly: boolean;
  readonly displayQty: Amount | null;
  readonly minQty: Amount | null;
  readonly aon: boolean;
}

interface MatchOutcome {
  readonly fills: Fill[];
  readonly remaining: Amount;
  readonly cancellations: CancelledRef[];
  readonly surveillanceCases: EngineSurveillanceCase[];
}

/** Cancel-resting. The engine does not invent a self-fill. */

function reject(code: RejectReason['code'], message: string): RejectReason {
  return { code, message };
}

const OPTION_TRIGGER_TYPES = new Set(['stop', 'stop_limit', 'stop_market', 'take_profit', 'take_limit', 'take_market', 'trailing_stop']);

function readTriggerBy(order: EngineOrder): 'last' | 'mark' | 'index' {
  if (order.triggerBy === 'mark' || order.triggerBy === 'index') return order.triggerBy;
  return 'last';
}

function readTriggerRole(order: EngineOrder): 'legacy' | 'take_profit' | 'stop_loss' {
  if (order.triggerRole === 'take_profit' || order.triggerRole === 'stop_loss') return order.triggerRole;
  return 'legacy';
}

function stopView(order: EngineOrder): {
  side: OrderSide;
  stopPrice: Amount;
  triggerBy: 'last' | 'mark' | 'index';
  triggerRole: 'legacy' | 'take_profit' | 'stop_loss';
} {
  return {
    side: order.side,
    stopPrice: order.stopPrice as Amount,
    triggerBy: readTriggerBy(order),
    triggerRole: readTriggerRole(order),
  };
}

/**
 * Price used to rank a reduce-only arrival.
 * A stop or stop-limit never outranks a resting row, whether or not it triggers now.
 * A market has no limit price and does not outrank one either.
 */
function incomingPrice(order: EngineOrder): Amount | null {
  if (order.type === 'stop' || order.type === 'stop_limit') return null;
  return order.price;
}

function moreAggressive(side: OrderSide, next: Amount | null, prior: Amount | null): boolean {
  if (next === null || prior === null) return false;
  return side === 'sell' ? next < prior : next > prior;
}

function compareLeastAggressive(
  side: OrderSide,
  a: { readonly price: Amount | null; readonly sequence: number },
  b: { readonly price: Amount | null; readonly sequence: number },
): number {
  if (a.price === null && b.price === null) return b.sequence - a.sequence;
  if (a.price === null) return 1;
  if (b.price === null) return -1;
  if (a.price === b.price) return b.sequence - a.sequence;
  if (side === 'sell') return a.price > b.price ? -1 : 1;
  return a.price < b.price ? -1 : 1;
}

function movedThrough(
  side: OrderSide,
  stopPrice: Amount,
  role: 'legacy' | 'take_profit' | 'stop_loss',
  previous: Amount | null,
  next: Amount | null,
): boolean {
  if (next === null) return false;
  if (role === 'legacy') return side === 'buy' ? next >= stopPrice : next <= stopPrice;
  if (previous === null) {
    if (side === 'sell' && role === 'take_profit') return next >= stopPrice;
    if (side === 'sell') return next <= stopPrice;
    if (role === 'take_profit') return next <= stopPrice;
    return next >= stopPrice;
  }
  if (next === previous) return false;
  const rising = next > previous;
  const falling = next < previous;
  if (side === 'sell' && role === 'take_profit') return rising && previous <= stopPrice && next >= stopPrice;
  if (side === 'sell') return falling && previous >= stopPrice && next <= stopPrice;
  if (role === 'take_profit') return falling && previous >= stopPrice && next <= stopPrice;
  return rising && previous <= stopPrice && next >= stopPrice;
}

function publishedBookL2Limit(value: number | undefined | null): number {
  if (value === undefined || value === null) {
    throw new Error('OrderBook depth limit is unset — refuse to invent 50');
  }
  return value;
}

/**
 * Pure check from the option module. A triggered stop must not print a resting option.
 * Null until that module loads. Matching stays on this book either way.
 */
export type OptionActivationGuard = (book: OrderBook, order: EngineOrder) => RejectReason | null;

let optionActivationGuard: OptionActivationGuard | null = null;

export function registerOptionActivationGuard(guard: OptionActivationGuard | null): void {
  optionActivationGuard = guard;
}

/** The order a triggered stop becomes. Market for a stop, limit for a stop_limit. */
function activationOrder(stop: StopOrder): EngineOrder {
  return {
    orderId: stop.orderId,
    accountId: stop.accountId,
    type: stop.type === 'stop_limit' ? 'limit' : 'market',
    side: stop.side,
    qty: stop.qty,
    price: stop.type === 'stop_limit' ? stop.price : null,
    stopPrice: null,
    tif: stop.tif,
    ocoSiblingId: stop.ocoSiblingId,
    reduceOnly: stop.reduceOnly,
    minQty: stop.minQty,
    aon: stop.aon,
  };
}

/** Both or neither. A missing trail or mark is not a walk — never invent the other. */
function trailPeak(order: { readonly trail?: Amount | null; readonly mark?: Amount | null }): {
  readonly trail: Amount | null;
  readonly peak: Amount | null;
} {
  const trail = order.trail != null && order.trail > ZERO ? order.trail : null;
  const peak = order.mark != null && order.mark > ZERO ? order.mark : null;
  if (trail === null || peak === null) return { trail: null, peak: null };
  return { trail, peak };
}

/** Snapshot pair. A missing or non-positive trail or peak stays off the stop. */
function trailPeakState(
  trail: string | null | undefined,
  peak: string | null | undefined,
): { readonly trail: Amount | null; readonly peak: Amount | null } {
  if (trail == null || peak == null) return { trail: null, peak: null };
  const trailAmt = parseAmount(trail);
  const peakAmt = parseAmount(peak);
  if (trailAmt <= ZERO || peakAmt <= ZERO) return { trail: null, peak: null };
  return { trail: trailAmt, peak: peakAmt };
}

/** Set by spread-book.ts when it wraps this class. Without it a spread order is refused, never matched bare. */
const SPREAD_BOOK = Symbol.for('intafaced.matching.spread-book');

export class OrderBook {
  readonly marketId: MarketId;

  private sequence = 0;
  private readonly bids: PriceLevel[] = [];
  private readonly asks: PriceLevel[] = [];
  private readonly stops: StopOrder[] = [];
  private readonly index = new Map<OrderId, RestingOrder>();
  /** Accepted ids, including filled/cancelled. A 200 retry must not rest or fill again. */
  private readonly acceptedIds = new Set<OrderId>();
  private readonly ocoMembers = new Set<OrderId>();
  private lastTradePrice: Amount | null = null;
  /** Prior last print. Null until a second print, so a book with no move does not trigger. */
  private previousTradePrice: Amount | null = null;
  /** Set only for the print that just happened. Cleared after stops drain, so a later submit does not reuse it. */
  private lastMove: { readonly previous: Amount | null; readonly next: Amount } | null = null;
  private markPrice: Amount | null = null;
  private indexPrice: Amount | null = null;
  /** Explicit futures position. Present, including zero, replaces the fill net for reduce-only. */
  private readonly futuresPositions = new Map<AccountId, Amount>();
  private readonly positions = new Map<AccountId, Amount>();
  /** STP (and later named abuse) evidence. Open only — never a fine, never auto-closed. */
  private readonly surveillanceCases: EngineSurveillanceCase[] = [];
  private depthCache: { sequence: number; limit: number; bids: Array<[string, string]>; asks: Array<[string, string]> } | null = null;

  constructor(marketId: MarketId) {
    this.marketId = marketId;
  }

  get currentSequence(): number {
    return this.sequence;
  }

  get lastPrice(): Amount | null {
    return this.lastTradePrice;
  }

  /** Open named cases from STP on this book. Evidence only. */
  openSurveillanceCases(): readonly EngineSurveillanceCase[] {
    return this.surveillanceCases;
  }

  get isNeverPrintedEmpty(): boolean {
    return this.lastTradePrice === null && this.index.size === 0 && this.stops.length === 0;
  }

  bestBid(): Amount | null {
    return this.bids[0]?.price ?? null;
  }

  bestAsk(): Amount | null {
    return this.asks[0]?.price ?? null;
  }

  /** `limit` is required. Unset refuses (never invent 50). Owner-explicit 50 is a published window. */
  depth(limit?: number | null): { bids: Array<[string, string]>; asks: Array<[string, string]>; sequence: number } {
    const n = publishedBookL2Limit(limit);
    const cached = this.depthCache;
    if (cached !== null && cached.sequence === this.sequence && cached.limit === n) {
      return { bids: [...cached.bids], asks: [...cached.asks], sequence: this.sequence };
    }

    const fold = (levels: readonly PriceLevel[]): Array<[string, string]> =>
      levels.slice(0, n).map((level) => {
        let total = ZERO;
        for (const order of level.orders) total += visibleRemaining(order.remaining, order.displayRemaining);
        return [formatAmount(level.price), formatAmount(total)];
      });

    const bids = fold(this.bids);
    const asks = fold(this.asks);
    this.depthCache = { sequence: this.sequence, limit: n, bids, asks };

    return { bids: [...bids], asks: [...asks], sequence: this.sequence };
  }

  submit(incoming: EngineOrder, now?: Date | null): SubmitResult {
    const pegged = pegIntentRefuse(incoming);
    if (pegged) return rejected(pegged);
    const order = bindPegRelative(incoming);
    if (order.positionQty !== undefined && order.positionQty !== null) {
      this.futuresPositions.set(order.accountId, order.positionQty);
    }
    const structural = this.validate(order, now);
    if (structural) return rejected(structural);
    const expired = now != null ? this.expireDue(now) : [];

    const isStop = order.type === 'stop' || order.type === 'stop_limit';
    const triggersNow = isStop && (this.isTriggered(stopView(order)) || this.alreadyAtStop(stopView(order)));
    // A stop already at or through its price goes straight to the book; say so with the last price it met.
    const arrival: TriggerFact | null =
      triggersNow && this.lastTradePrice !== null
        ? triggerFact(readTriggerBy(order), order.stopPrice as Amount, this.lastTradePrice)
        : null;

    if (isStop && !triggersNow) {
      const displaced = this.displaceReduceOnly(order);
      const sequence = this.nextSequence();
      const walked = trailPeak(order);
      this.stops.push({
        orderId: order.orderId,
        accountId: order.accountId,
        type: order.type as 'stop' | 'stop_limit',
        side: order.side,
        qty: order.qty,
        price: order.price,
        stopPrice: order.stopPrice as Amount,
        tif: order.tif,
        sequence,
        version: 1,
        ocoSiblingId: order.ocoSiblingId ?? null,
        expireAt: order.expireAt ?? null,
        sessionId: readSessionId(order),
        reduceOnly: order.reduceOnly === true,
        triggerBy: readTriggerBy(order),
        triggerRole: readTriggerRole(order),
        minQty: readMinQty(order),
        aon: readAon(order),
        trail: walked.trail,
        peak: walked.peak,
      });
      this.rememberAccepted(order.orderId);
      this.rememberOco(order);
      this.linkLiveSibling(order.orderId, order.ocoSiblingId ?? null);
      return {
        accepted: true,
        sequence,
        fills: [],
        resting: {
          kind: 'stop',
          orderId: order.orderId,
          accountId: order.accountId,
          side: order.side,
          price: order.stopPrice as Amount,
          remaining: order.qty,
          sequence,
          version: 1,
        },
        cancellations: [...displaced, ...expired],
        triggered: [],
      };
    }

    const effective = toEffective(order);
    const viability = this.checkViability(effective);
    if (viability) {
      // A maker-or-cancel that would take is consumed. A retry of the same id must not rest.
      if (effective.tif === 'MOC' && viability.code === 'moc_would_take') this.rememberAccepted(order.orderId);
      return rejected(viability);
    }

    const displaced = this.displaceReduceOnly(order);
    const sequence = this.nextSequence();
    const outcome = this.execute(effective, sequence);
    this.recordPrints(outcome.fills);
    this.applyFillsToPosition(outcome.fills);
    const reduceCancels = this.cancelReduceOnlyDue();
    this.rememberAccepted(order.orderId);
    this.rememberOco(order);
    this.linkLiveSibling(order.orderId, order.ocoSiblingId ?? null);
    const ocoCancels = this.cancelOcoSiblings(outcome.fills, order);
    const triggered = this.drainStops();
    this.lastMove = null;
    const surveillanceCases = collectSurveillance(outcome.surveillanceCases, triggered);

    return {
      accepted: true,
      sequence,
      fills: outcome.fills,
      resting: outcome.resting,
      cancellations: [...displaced, ...expired, ...outcome.cancellations, ...reduceCancels, ...ocoCancels],
      // The arrival is reported like any other trigger, so every composer (bracket, OCO) carries it to the event.
      triggered: arrival
        ? [{ orderId: order.orderId, sequence, fills: [], resting: null, cancellations: [], trigger: arrival }, ...triggered]
        : triggered,
      ...(surveillanceCases.length > 0 ? { surveillanceCases } : {}),
    };
  }

  cancel(orderId: OrderId, reason: CancelReason = 'requested'): CancelResult {
    const resting = this.index.get(orderId);
    if (resting) {
      this.removeResting(resting);
      this.acceptedIds.delete(orderId);
      const sequence = this.nextSequence();
      return {
        cancelled: true,
        orderId,
        sequence,
        cancellation: {
          orderId,
          accountId: resting.accountId,
          remainingQty: resting.remaining,
          sequence,
          reason,
        },
      };
    }

    const stopIndex = this.stops.findIndex((s) => s.orderId === orderId);
    if (stopIndex !== -1) {
      const stop = this.stops.splice(stopIndex, 1)[0] as StopOrder;
      this.acceptedIds.delete(orderId);
      const sequence = this.nextSequence();
      return {
        cancelled: true,
        orderId,
        sequence,
        cancellation: { orderId, accountId: stop.accountId, remainingQty: stop.qty, sequence, reason },
      };
    }

    return { cancelled: false, orderId, sequence: null, cancellation: null };
  }

  /** Pull live rest and stop for this account. Present side is that side only. Other accounts stay. */
  cancelAccount(accountId: AccountId, side?: OrderSide | null): readonly CancelledRef[] {
    const live = [
      ...[...this.index.values()].map((o) => ({
        orderId: o.orderId,
        accountId: o.accountId,
        sequence: o.sequence,
        side: o.side,
      })),
      ...this.stops.map((s) => ({ orderId: s.orderId, accountId: s.accountId, sequence: s.sequence, side: s.side })),
    ];
    const cancellations: CancelledRef[] = [];
    for (const orderId of ownedOrderIds(accountId, live, side)) {
      const result = this.cancel(orderId);
      if (result.cancellation) cancellations.push(result.cancellation);
    }
    return cancellations;
  }

  /** Pull live rest and stop tagged with this session. Untagged rests stay. Missing session matches nothing. */
  cancelSession(sessionId: string): readonly CancelledRef[] {
    const live = [
      ...[...this.index.values()].map((o) => ({
        orderId: o.orderId,
        sessionId: o.sessionId,
        sequence: o.sequence,
      })),
      ...this.stops.map((s) => ({ orderId: s.orderId, sessionId: s.sessionId, sequence: s.sequence })),
    ];
    const cancellations: CancelledRef[] = [];
    for (const orderId of sessionOrderIds(sessionId, live)) {
      const result = this.cancel(orderId, 'session_dead');
      if (result.cancellation) cancellations.push(result.cancellation);
    }
    return cancellations;
  }

  amend(cmd: EngineAmend, now?: Date | null): AmendResult {
    const expired = now != null ? this.expireDue(now) : [];
    const attach = (result: AmendResult): AmendResult =>
      expired.length === 0 ? result : { ...result, cancellations: [...expired, ...result.cancellations] };

    const resting = this.index.get(cmd.orderId);
    if (resting) return attach(this.amendResting(resting, cmd));

    const stop = this.stops.find((s) => s.orderId === cmd.orderId);
    if (stop) return attach(this.amendStop(stop, cmd));

    if (expired.some((row) => row.orderId === cmd.orderId)) {
      return attach(refusedAmend(cmd.orderId, reject('already_expired', 'expireAt is not after the engine clock')));
    }
    return attach(refusedAmend(cmd.orderId, reject('order_not_found', `order ${cmd.orderId} is not live in ${this.marketId}`)));
  }

  private amendResting(resting: RestingOrder, cmd: EngineAmend): AmendResult {
    if (cmd.expectedVersion !== resting.version) {
      return refusedAmend(cmd.orderId, reject('version_mismatch', `order ${cmd.orderId} is at version ${resting.version}`));
    }
    if (cmd.stopPrice !== undefined) {
      return refusedAmend(cmd.orderId, reject('unexpected_stop_price', 'a resting limit order must not carry a stopPrice'));
    }

    const qty = cmd.qty ?? resting.remaining;
    const price = cmd.price ?? resting.price;
    if (qty <= ZERO) return refusedAmend(cmd.orderId, reject('invalid_qty', 'quantity must be strictly positive'));
    if (price <= ZERO) return refusedAmend(cmd.orderId, reject('invalid_price', 'price must be strictly positive'));
    if (resting.reduceOnly && this.wouldIncreasePosition(resting.accountId, resting.side, qty, resting.orderId)) {
      return refusedAmend(
        cmd.orderId,
        reject('would_increase_position', 'reduce-only refuses a qty that would increase the position; the engine does not invent a mark'),
      );
    }

    const tif: TimeInForce = cmd.tif ?? (resting.postOnly ? 'PO' : 'GTC');
    const tifForcesReexecute = tif === 'IOC' || tif === 'FOK';
    const retain = price === resting.price && !tifForcesReexecute && qty <= resting.remaining;

    if (retain) {
      const floor = minQtyRefuse(qty, resting.minQty);
      if (floor) return refusedAmend(cmd.orderId, reject(floor.code, floor.message));
      if (cmd.expireAt !== undefined) resting.expireAt = cmd.expireAt;
      if (tif === 'PO') resting.postOnly = true;
      resting.remaining = qty;
      resting.version += 1;
      this.nextSequence();
      return {
        accepted: true,
        orderId: resting.orderId,
        sequence: resting.sequence,
        version: resting.version,
        priority: 'retained',
        fills: [],
        resting: toRestingRef(resting),
        cancellations: [],
        triggered: [],
      };
    }

    const effective: EffectiveOrder = {
      orderId: resting.orderId,
      accountId: resting.accountId,
      side: resting.side,
      qty,
      price,
      tif,
      ocoSiblingId: resting.ocoSiblingId,
      expireAt: cmd.expireAt ?? resting.expireAt,
      sessionId: resting.sessionId,
      reduceOnly: resting.reduceOnly,
      displayQty: resting.displayPeak,
      minQty: resting.minQty,
      aon: resting.aon,
    };
    const viability = this.checkViability(effective);
    if (viability) return refusedAmend(cmd.orderId, viability);

    const nextVersion = resting.version + 1;
    this.removeResting(resting);
    const sequence = this.nextSequence();
    const outcome = this.execute(effective, sequence, nextVersion);
    this.recordPrints(outcome.fills);
    this.applyFillsToPosition(outcome.fills);
    const reduceCancels = this.cancelReduceOnlyDue();
    const ocoCancels = this.cancelOcoSiblings(outcome.fills, {
      orderId: resting.orderId,
      ocoSiblingId: resting.ocoSiblingId,
    });
    const triggered = this.drainStops();
    this.lastMove = null;
    const surveillanceCases = collectSurveillance(outcome.surveillanceCases, triggered);
    return {
      accepted: true,
      orderId: cmd.orderId,
      sequence: outcome.resting?.sequence ?? sequence,
      version: outcome.resting?.version ?? nextVersion,
      priority: 'lost',
      fills: outcome.fills,
      resting: outcome.resting,
      cancellations: [...outcome.cancellations, ...reduceCancels, ...ocoCancels],
      triggered,
      ...(surveillanceCases.length > 0 ? { surveillanceCases } : {}),
    };
  }

  private amendStop(stop: StopOrder, cmd: EngineAmend): AmendResult {
    if (cmd.expectedVersion !== stop.version) {
      return refusedAmend(cmd.orderId, reject('version_mismatch', `order ${cmd.orderId} is at version ${stop.version}`));
    }
    if (stop.type === 'stop' && cmd.price !== undefined) {
      return refusedAmend(cmd.orderId, reject('unexpected_price', 'a stop order must not carry a limit price'));
    }

    const qty = cmd.qty ?? stop.qty;
    const price = cmd.price !== undefined ? cmd.price : stop.price;
    const stopPrice = cmd.stopPrice ?? stop.stopPrice;
    const tif = cmd.tif ?? stop.tif;
    if (qty <= ZERO) return refusedAmend(cmd.orderId, reject('invalid_qty', 'quantity must be strictly positive'));
    if (stopPrice <= ZERO) return refusedAmend(cmd.orderId, reject('invalid_price', 'stopPrice must be strictly positive'));
    if (stop.type === 'stop_limit') {
      if (price === null) return refusedAmend(cmd.orderId, reject('missing_price', 'a stop_limit order requires a price'));
      if (price <= ZERO) return refusedAmend(cmd.orderId, reject('invalid_price', 'price must be strictly positive'));
    }
    if (stop.reduceOnly && this.wouldIncreasePosition(stop.accountId, stop.side, qty, stop.orderId)) {
      return refusedAmend(
        cmd.orderId,
        reject('would_increase_position', 'reduce-only refuses a qty that would increase the position; the engine does not invent a mark'),
      );
    }

    const tifForcesReexecute = tif === 'IOC' || tif === 'FOK';
    const sameLimit = (price === null && stop.price === null) || (price !== null && stop.price !== null && price === stop.price);
    const retain = stopPrice === stop.stopPrice && sameLimit && tif === stop.tif && !tifForcesReexecute && qty <= stop.qty;

    if (retain) {
      if (cmd.expireAt !== undefined) stop.expireAt = cmd.expireAt;
      stop.qty = qty;
      stop.version += 1;
      this.nextSequence();
      return {
        accepted: true,
        orderId: stop.orderId,
        sequence: stop.sequence,
        version: stop.version,
        priority: 'retained',
        fills: [],
        resting: {
          kind: 'stop',
          orderId: stop.orderId,
          accountId: stop.accountId,
          side: stop.side,
          price: stop.stopPrice,
          remaining: stop.qty,
          sequence: stop.sequence,
          version: stop.version,
        },
        cancellations: [],
        triggered: [],
      };
    }

    const updated: StopOrder = {
      ...stop,
      qty,
      price,
      stopPrice,
      tif,
      version: stop.version + 1,
      ocoSiblingId: stop.ocoSiblingId,
    };
    const effective: EffectiveOrder = {
      orderId: updated.orderId,
      accountId: updated.accountId,
      side: updated.side,
      qty: updated.qty,
      price: updated.type === 'stop_limit' ? updated.price : null,
      tif: updated.tif,
      ocoSiblingId: updated.ocoSiblingId,
      expireAt: cmd.expireAt ?? updated.expireAt,
      sessionId: updated.sessionId,
      reduceOnly: updated.reduceOnly,
      displayQty: null,
      minQty: updated.minQty,
      aon: updated.aon,
    };

    if (this.armedThrough(updated) || this.isTriggered(updated)) {
      const viability = this.checkViability(effective);
      if (viability) return refusedAmend(cmd.orderId, viability);
      const at = this.stops.findIndex((s) => s.orderId === stop.orderId);
      if (at !== -1) this.stops.splice(at, 1);
      const triggered = this.fire(updated, this.lastTradePrice as Amount);
      const cascade = this.drainStops();
      this.lastMove = null;
      const surveillanceCases = collectSurveillance(triggered.surveillanceCases ?? [], cascade);
      return {
        accepted: true,
        orderId: cmd.orderId,
        sequence: triggered.resting?.sequence ?? triggered.sequence,
        version: triggered.resting?.version ?? updated.version,
        priority: 'lost',
        fills: triggered.fills,
        resting: triggered.resting,
        cancellations: triggered.cancellations,
        triggered: [triggered, ...cascade],
        rejected: triggered.rejected,
        ...(surveillanceCases.length > 0 ? { surveillanceCases } : {}),
      };
    }

    const at = this.stops.findIndex((s) => s.orderId === stop.orderId);
    if (at !== -1) this.stops.splice(at, 1);
    const sequence = this.nextSequence();
    const lost: StopOrder = { ...updated, sequence };
    this.stops.push(lost);
    return {
      accepted: true,
      orderId: lost.orderId,
      sequence: lost.sequence,
      version: lost.version,
      priority: 'lost',
      fills: [],
      resting: {
        kind: 'stop',
        orderId: lost.orderId,
        accountId: lost.accountId,
        side: lost.side,
        price: lost.stopPrice,
        remaining: lost.qty,
        sequence: lost.sequence,
        version: lost.version,
      },
      cancellations: [],
      triggered: [],
    };
  }

  private validate(order: EngineOrder, now?: Date | null): RejectReason | null {
    if (order.spread != null && (OrderBook.prototype as unknown as Record<symbol, unknown>)[SPREAD_BOOK] !== true) {
      return reject('spread_order_unsupported', 'spread orders need the spread book hitch; the core book does not price legs');
    }
    const rawType = order.type as string;
    if ((order.instrument === 'option' || order.instrument === 'option_combo') && OPTION_TRIGGER_TYPES.has(rawType)) {
      return reject(
        'option_trigger_unsupported',
        'stop_limit, stop_market, take_limit, take_market, and trailing_stop are not supported on option or option_combo',
      );
    }
    const missingStp = stpIdentityRefuse(order.accountId);
    if (missingStp) return missingStp;
    if (order.qty <= ZERO) return reject('invalid_qty', 'quantity must be strictly positive');
    if (this.hasAccepted(order.orderId) || this.isLive(order.orderId)) {
      return reject('duplicate_order_id', `order ${order.orderId} was already accepted in ${this.marketId}`);
    }

    const sibling = order.ocoSiblingId ?? null;
    if (sibling !== null) {
      if (sibling === order.orderId || sibling.length === 0) {
        return reject('invalid_oco_sibling', 'an OCO order cannot name itself as its sibling');
      }
      if (this.isOcoTerminal(sibling)) {
        return reject('oco_sibling_terminal', `oco sibling ${sibling} is already terminal`);
      }
    }

    const needsPrice = order.type === 'limit' || order.type === 'stop_limit';
    if (needsPrice) {
      if (order.price === null) return reject('missing_price', `a ${order.type} order requires a price`);
      // A spread price is a weighted leg-price difference and may be zero or negative (spread-instrument.ts).
      if (order.price <= ZERO && order.spread == null) return reject('invalid_price', 'price must be strictly positive');
    } else if (order.price !== null) {
      return reject('unexpected_price', `a ${order.type} order must not carry a limit price`);
    }

    const needsStop = order.type === 'stop' || order.type === 'stop_limit';
    if (needsStop) {
      if (order.stopPrice === null) return reject('missing_stop_price', `a ${order.type} order requires a stopPrice`);
      if (order.stopPrice <= ZERO) return reject('invalid_price', 'stopPrice must be strictly positive');
    } else if (order.stopPrice !== null) {
      return reject('unexpected_stop_price', `a ${order.type} order must not carry a stopPrice`);
    }

    if (order.triggerRole === 'take_profit' && needsStop && order.stopPrice !== null) {
      if (this.lastTradePrice === null) {
        return reject('missing_last_price', 'a take-profit needs a last trade; the engine does not invent one');
      }
      if (order.side === 'sell' && order.stopPrice <= this.lastTradePrice) {
        return reject('trigger_wrong_side', 'a take-profit sell is valid only above the market');
      }
      if (order.side === 'buy' && order.stopPrice >= this.lastTradePrice) {
        return reject('trigger_wrong_side', 'a take-profit buy is valid only below the market');
      }
    }

    if (order.tif === 'PO' && !needsPrice) {
      return reject('invalid_tif', 'post-only requires a limit price');
    }
    if (order.tif === 'MOC' && !needsPrice) {
      return reject('invalid_tif', 'maker-or-cancel requires a limit price');
    }

    if (order.tif === 'GTD' || order.tif === 'GTT') {
      if (order.type === 'market') {
        return reject('invalid_tif', 'GTD/GTT cannot rest a market order');
      }
      const expireAt = order.expireAt ?? '';
      if (expireAt.length === 0) {
        return reject('missing_expire_at', 'GTD/GTT requires expireAt; the engine does not invent one');
      }
      const expireMs = Date.parse(expireAt);
      if (!Number.isFinite(expireMs)) {
        return reject('missing_expire_at', 'expireAt must be an ISO instant; the engine does not invent one');
      }
      if (now == null) {
        return reject('engine_clock_missing', 'GTD/GTT expires on the engine clock; refuse when that clock is missing');
      }
      if (expireMs <= now.getTime()) {
        return reject('already_expired', 'expireAt is not after the engine clock');
      }
    }

    if (order.reduceOnly === true && this.incomingReduceOnlyRefused(order)) {
      return reject(
        'would_increase_position',
        'reduce-only refuses a qty that would increase the position; the engine does not invent a mark',
      );
    }

    if (wantsIceberg(order)) {
      const display = icebergDisplayRefuse(order.qty, order.displayQty ?? null);
      if (display) return reject(display.code, display.message);
      if (order.price === null) return reject('missing_price', 'an iceberg requires a limit price; the engine does not invent a display');
    }

    const floor = minQtyRefuse(order.qty, readMinQty(order));
    if (floor) return reject(floor.code, floor.message);

    const aonHidden = aonIcebergRefuse(readAon(order), wantsIceberg(order));
    if (aonHidden) return reject(aonHidden.code, aonHidden.message);

    const pegged = pegIntentRefuse(order);
    if (pegged) return reject(pegged.code, pegged.message);

    const auctioned = auctionIntentRefuse(order);
    if (auctioned) return reject(auctioned.code, auctioned.message);

    const collared = collarIntentRefuse(order);
    if (collared) return reject(collared.code, collared.message);

    const notioned = minNotionalIntentRefuse(order);
    if (notioned) return reject(notioned.code, notioned.message);

    return null;
  }

  private expireDue(now: Date): CancelledRef[] {
    const nowMs = now.getTime();
    const due: OrderId[] = [];
    for (const o of this.index.values()) {
      if (o.expireAt && Date.parse(o.expireAt) <= nowMs) due.push(o.orderId);
    }
    for (const s of this.stops) {
      if (s.expireAt && Date.parse(s.expireAt) <= nowMs) due.push(s.orderId);
    }
    due.sort();
    const out: CancelledRef[] = [];
    for (const orderId of due) {
      const resting = this.index.get(orderId);
      if (resting) {
        this.removeResting(resting);
        const sequence = this.nextSequence();
        out.push({
          orderId,
          accountId: resting.accountId,
          remainingQty: resting.remaining,
          sequence,
          reason: 'expired',
        });
        continue;
      }
      const stopIndex = this.stops.findIndex((s) => s.orderId === orderId);
      if (stopIndex !== -1) {
        const stop = this.stops.splice(stopIndex, 1)[0] as StopOrder;
        const sequence = this.nextSequence();
        out.push({
          orderId,
          accountId: stop.accountId,
          remainingQty: stop.qty,
          sequence,
          reason: 'expired',
        });
      }
    }
    return out;
  }

  private checkViability(order: EffectiveOrder): RejectReason | null {
    if (order.tif === 'PO' && order.price !== null && this.wouldCross(order.side, order.price)) {
      return reject('post_only_would_cross', 'post-only order would take liquidity');
    }
    if (order.tif === 'MOC' && order.price !== null && this.wouldCross(order.side, order.price)) {
      return reject('moc_would_take', 'maker-or-cancel order would take liquidity');
    }

    if (order.tif === 'FOK' && this.fillableQty(order) < order.qty) {
      return reject('fok_unfillable', 'fill-or-kill order cannot be filled in full');
    }

    return null;
  }

  private wouldCross(side: OrderSide, price: Amount): boolean {
    if (side === 'buy') {
      const ask = this.bestAsk();
      return ask !== null && price >= ask;
    }
    const bid = this.bestBid();
    return bid !== null && price <= bid;
  }

  private fillableQty(order: EffectiveOrder): Amount {
    let total = ZERO;
    let remaining = order.qty;
    const takerMin = readMinQty(order);
    const removed = new Set<OrderId>();
    const fills: Fill[] = [];
    for (const level of order.side === 'buy' ? this.asks : this.bids) {
      if (order.price !== null && !crossesLevel(order.side, order.price, level.price)) break;
      for (const maker of level.orders) {
        if (remaining === ZERO) return total;
        if (removed.has(maker.orderId)) continue;
        if (!stpIdentityPresent(order.accountId) || !stpIdentityPresent(maker.accountId)) {
          return total;
        }
        if (isSelfTrade(order.accountId, maker.accountId)) {
          // STP expires this rest and continues. Do not count it as fillable.
          continue;
        }
        let clip = min(remaining, visibleRemaining(maker.remaining, maker.displayRemaining));
        if (clip === ZERO) return total;
        if (maker.reduceOnly) {
          const open = this.openQty(this.netAfterFills(maker.accountId, fills), maker.side);
          if (open === ZERO) continue;
          clip = min(clip, open);
        }
        if (!clipMeetsAon(clip, maker.remaining, maker.aon)) return total;
        const takerAfter = remaining - clip;
        const makerAfter = maker.remaining - clip;
        if (!bothSidesMeetMinQty(clip, takerAfter, takerMin, makerAfter, readMinQty(maker))) return total;
        total += clip;
        remaining -= clip;
        fills.push({
          sequence: 0,
          makerOrderId: maker.orderId,
          makerAccountId: maker.accountId,
          takerOrderId: order.orderId,
          takerAccountId: order.accountId,
          takerSide: order.side,
          price: maker.price,
          qty: clip,
        });
        const makerSibling = this.siblingOf(maker.orderId, order);
        const takerSibling = this.siblingOf(order.orderId, order);
        if (makerSibling) removed.add(makerSibling);
        if (takerSibling) removed.add(takerSibling);
      }
    }
    return total;
  }

  private execute(
    order: EffectiveOrder,
    sequence: number,
    version = 1,
  ): { fills: Fill[]; resting: RestingRef | null; cancellations: CancelledRef[]; surveillanceCases: EngineSurveillanceCase[] } {
    const matched =
      !order.aon || canFillAon(this.fillableQty(order), order.qty, true)
        ? this.match(order)
        : {
            fills: [] as Fill[],
            remaining: order.qty,
            cancellations: [] as CancelledRef[],
            surveillanceCases: [] as EngineSurveillanceCase[],
          };
    const cancellations = matched.cancellations;
    let resting: RestingRef | null = null;

    if (matched.remaining > ZERO) {
      const canRest =
        order.price !== null &&
        (order.tif === 'GTC' || order.tif === 'PO' || order.tif === 'MOC' || order.tif === 'GTD' || order.tif === 'GTT');
      if (canRest) {
        resting = this.rest(order, matched.remaining, sequence, version);
      } else {
        cancellations.push({
          orderId: order.orderId,
          accountId: order.accountId,
          remainingQty: matched.remaining,
          sequence: this.nextSequence(),
          reason: order.price === null ? 'market_remainder' : 'ioc_remainder',
        });
      }
    }

    return { fills: matched.fills, resting, cancellations, surveillanceCases: matched.surveillanceCases };
  }

  private match(order: EffectiveOrder): MatchOutcome {
    const opposite = order.side === 'buy' ? this.asks : this.bids;
    const fills: Fill[] = [];
    const cancellations: CancelledRef[] = [];
    const surveillanceCases: EngineSurveillanceCase[] = [];
    let remaining = order.qty;

    const slicedThisTake = new Set<string>();
    const ocoFired = new Set<OrderId>();

    matchLevels: for (let levelIndex = 0; remaining > ZERO && levelIndex < opposite.length;) {
      const level = opposite[levelIndex] as PriceLevel;
      if (order.price !== null && !crossesLevel(order.side, order.price, level.price)) break;

      let levelDone = false;
      while (remaining > ZERO && level.orders.length > 0) {
        const maker = level.orders[0] as RestingOrder;
        if (slicedThisTake.has(maker.orderId)) {
          levelDone = true;
          break;
        }

        if (!stpIdentityPresent(order.accountId) || !stpIdentityPresent(maker.accountId)) {
          break matchLevels;
        }

        if (isSelfTrade(order.accountId, maker.accountId)) {
          const sequence = this.nextSequence();
          cancellations.push(selfTradeExpire(maker.orderId, maker.accountId, maker.remaining, sequence));
          const opened = selfTradeSurveillanceCase(maker.accountId, this.marketId);
          if (opened.ok) {
            this.surveillanceCases.push(opened.case);
            surveillanceCases.push(opened.case);
          }
          level.orders.shift();
          this.index.delete(maker.orderId);
          if (level.orders.length === 0) {
            opposite.splice(levelIndex, 1);
            continue matchLevels;
          }
          continue;
        }

        let qty = min(remaining, visibleRemaining(maker.remaining, maker.displayRemaining));
        if (qty === ZERO) break;
        if (maker.reduceOnly) {
          const open = this.openQty(this.netAfterFills(maker.accountId, fills), maker.side);
          if (open === ZERO) {
            if (this.pullReduceOnlyMaker(opposite, levelIndex, level, maker, cancellations)) continue matchLevels;
            continue;
          }
          if (qty > open) qty = open;
        }
        if (!clipMeetsAon(qty, maker.remaining, maker.aon)) break matchLevels;

        const takerAfter = remaining - qty;
        const makerAfter = maker.remaining - qty;
        if (!bothSidesMeetMinQty(qty, takerAfter, readMinQty(order), makerAfter, readMinQty(maker))) {
          break matchLevels;
        }

        fills.push({
          sequence: this.nextSequence(),
          makerOrderId: maker.orderId,
          makerAccountId: maker.accountId,
          takerOrderId: order.orderId,
          takerAccountId: order.accountId,
          takerSide: order.side,
          price: maker.price,
          qty,
        });

        maker.remaining -= qty;
        remaining -= qty;
        if (maker.displayRemaining !== null) maker.displayRemaining -= qty;

        // The sibling is still on the book. Pull it before the sweep reaches it.
        this.pullOcoLink(maker.orderId, order, ocoFired, cancellations);
        this.pullOcoLink(order.orderId, order, ocoFired, cancellations);

        if (maker.remaining === ZERO) {
          level.orders.shift();
          this.index.delete(maker.orderId);
        } else if (maker.reduceOnly && this.openQty(this.netAfterFills(maker.accountId, fills), maker.side) === ZERO) {
          if (this.pullReduceOnlyMaker(opposite, levelIndex, level, maker, cancellations)) continue matchLevels;
        } else if (maker.displayRemaining === ZERO && maker.displayPeak !== null) {
          maker.displayRemaining = refillDisplay(maker.displayPeak, maker.remaining);
          slicedThisTake.add(maker.orderId);
          level.orders.shift();
          level.orders.push(maker);
        }
      }

      if (level.orders.length === 0) {
        opposite.splice(levelIndex, 1);
        continue;
      }
      if (levelDone) {
        levelIndex += 1;
        continue;
      }
      break;
    }

    return { fills, remaining, cancellations, surveillanceCases };
  }

  private rest(order: EffectiveOrder, remaining: Amount, sequence: number, version = 1): RestingRef {
    const price = order.price as Amount;
    const resting: RestingOrder = {
      orderId: order.orderId,
      accountId: order.accountId,
      side: order.side,
      price,
      remaining,
      sequence,
      version,
      ocoSiblingId: order.ocoSiblingId,
      expireAt: order.expireAt,
      sessionId: order.sessionId,
      reduceOnly: order.reduceOnly,
      postOnly: order.tif === 'PO',
      displayPeak: order.displayQty,
      displayRemaining: order.displayQty === null ? null : min(order.displayQty, remaining),
      minQty: order.minQty,
      aon: order.aon,
    };

    const levels = order.side === 'buy' ? this.bids : this.asks;
    const { position, found } = locate(levels, price, order.side === 'buy');
    if (found) (levels[position] as PriceLevel).orders.push(resting);
    else levels.splice(position, 0, { price, orders: [resting] });

    this.index.set(order.orderId, resting);
    return toRestingRef(resting);
  }

  private removeResting(resting: RestingOrder): void {
    const levels = resting.side === 'buy' ? this.bids : this.asks;
    const { position, found } = locate(levels, resting.price, resting.side === 'buy');
    if (!found) return;

    const level = levels[position] as PriceLevel;
    const at = level.orders.indexOf(resting);
    if (at !== -1) level.orders.splice(at, 1);
    if (level.orders.length === 0) levels.splice(position, 1);
    this.index.delete(resting.orderId);
  }

  private recordPrints(fills: readonly Fill[]): void {
    const last = fills[fills.length - 1];
    if (!last) return;
    const previous = this.lastTradePrice;
    this.previousTradePrice = previous;
    this.lastTradePrice = last.price;
    this.lastMove = { previous, next: last.price };
  }

  private isTriggered(stop: {
    readonly side: OrderSide;
    readonly stopPrice: Amount;
    readonly triggerBy: 'last' | 'mark' | 'index';
    readonly triggerRole: 'legacy' | 'take_profit' | 'stop_loss';
  }): boolean {
    if (stop.triggerBy !== 'last' || this.lastMove === null) return false;
    return movedThrough(stop.side, stop.stopPrice, stop.triggerRole, this.lastMove.previous, this.lastMove.next);
  }

  private alreadyAtStop(stop: {
    readonly side: OrderSide;
    readonly stopPrice: Amount;
    readonly triggerBy: 'last' | 'mark' | 'index';
    readonly triggerRole: 'legacy' | 'take_profit' | 'stop_loss';
  }): boolean {
    if (this.lastTradePrice === null || stop.triggerBy !== 'last' || stop.triggerRole === 'take_profit') return false;
    if (stop.triggerRole === 'legacy') {
      return stop.side === 'buy' ? this.lastTradePrice >= stop.stopPrice : this.lastTradePrice <= stop.stopPrice;
    }
    return this.lastTradePrice === stop.stopPrice;
  }

  /** Amend still uses the level test: a sell stop at or through last is already live. */
  private armedThrough(stop: {
    readonly side: OrderSide;
    readonly stopPrice: Amount;
    readonly triggerBy: 'last' | 'mark' | 'index';
    readonly triggerRole: 'legacy' | 'take_profit' | 'stop_loss';
  }): boolean {
    if (this.lastTradePrice === null || stop.triggerBy !== 'last') return false;
    const last = this.lastTradePrice;
    if (stop.triggerRole === 'take_profit') {
      return stop.side === 'sell' ? last >= stop.stopPrice : last <= stop.stopPrice;
    }
    return stop.side === 'buy' ? last >= stop.stopPrice : last <= stop.stopPrice;
  }

  /** Main's level test. A legacy sell fires when last is at or through the stop; a buy does the same upward. */
  private legacyLevelTriggered(stop: StopOrder): boolean {
    if (stop.triggerRole !== 'legacy' || stop.triggerBy !== 'last' || this.lastTradePrice === null) return false;
    return stop.side === 'buy' ? this.lastTradePrice >= stop.stopPrice : this.lastTradePrice <= stop.stopPrice;
  }

  /**
   * Legacy stops (no role tag) re-scan from index 0 after every activation.
   * The level test uses lastTradePrice, so a stop the price already passed still fires when lastMove is null.
   */
  private drainLegacyStops(outcomes: TriggerOutcome[]): void {
    for (;;) {
      const at = this.stops.findIndex((stop) => this.legacyLevelTriggered(stop));
      if (at === -1) break;
      const stop = this.stops.splice(at, 1)[0]!;
      outcomes.push(this.fire(stop, this.lastTradePrice as Amount));
    }
  }

  private drainStops(): TriggerOutcome[] {
    const outcomes: TriggerOutcome[] = [];
    this.drainLegacyStops(outcomes);
    while (this.lastMove) {
      const move = this.lastMove;
      const batch: StopOrder[] = [];
      for (let index = this.stops.length - 1; index >= 0; index -= 1) {
        const stop = this.stops[index]!;
        if (stop.triggerBy !== 'last') continue;
        if (stop.triggerRole !== 'take_profit' && stop.triggerRole !== 'stop_loss') continue;
        if (!movedThrough(stop.side, stop.stopPrice, stop.triggerRole, move.previous, move.next)) continue;
        batch.push(this.stops.splice(index, 1)[0]!);
      }
      if (batch.length === 0) break;
      batch.reverse();
      for (const stop of batch) outcomes.push(this.fire(stop, move.next));
      if (this.lastMove === move) break;
      this.drainLegacyStops(outcomes);
    }
    return outcomes;
  }

  /** Activate a stop and record why: the reference it watches reached its stop price at `reference`. */
  private fire(stop: StopOrder, reference: Amount): TriggerOutcome {
    return { ...this.activate(stop), trigger: triggerFact(stop.triggerBy, stop.stopPrice, reference) };
  }

  private activate(stop: StopOrder): TriggerOutcome {
    const effective: EffectiveOrder = {
      orderId: stop.orderId,
      accountId: stop.accountId,
      side: stop.side,
      qty: stop.qty,
      price: stop.type === 'stop_limit' ? stop.price : null,
      tif: stop.tif,
      ocoSiblingId: stop.ocoSiblingId,
      expireAt: stop.expireAt,
      sessionId: stop.sessionId,
      reduceOnly: stop.reduceOnly,
      displayQty: null,
      minQty: stop.minQty,
      aon: stop.aon,
    };

    const viability = this.checkViability(effective);
    if (viability) {
      const sequence = this.nextSequence();
      return {
        orderId: stop.orderId,
        sequence,
        fills: [],
        resting: null,
        cancellations: [
          {
            orderId: stop.orderId,
            accountId: stop.accountId,
            remainingQty: stop.qty,
            sequence,
            reason: 'trigger_rejected',
          },
        ],
        rejected: viability,
      };
    }

    const optionTake = optionActivationGuard?.(this, activationOrder(stop)) ?? null;
    if (optionTake) {
      const sequence = this.nextSequence();
      return {
        orderId: stop.orderId,
        sequence,
        fills: [],
        resting: null,
        cancellations: [
          {
            orderId: stop.orderId,
            accountId: stop.accountId,
            remainingQty: stop.qty,
            sequence,
            reason: 'trigger_rejected',
          },
        ],
        rejected: optionTake,
      };
    }

    const sequence = this.nextSequence();
    const outcome = this.execute(effective, sequence, stop.version);
    this.recordPrints(outcome.fills);
    this.applyFillsToPosition(outcome.fills);
    const reduceCancels = this.cancelReduceOnlyDue();
    const ocoCancels = this.cancelOcoSiblings(outcome.fills, stop);
    return {
      orderId: stop.orderId,
      sequence,
      fills: outcome.fills,
      resting: outcome.resting,
      cancellations: [...outcome.cancellations, ...reduceCancels, ...ocoCancels],
      ...(outcome.surveillanceCases.length > 0 ? { surveillanceCases: outcome.surveillanceCases } : {}),
    };
  }

  hasAccepted(orderId: OrderId): boolean {
    return this.acceptedIds.has(orderId);
  }

  private rememberAccepted(orderId: OrderId): void {
    this.acceptedIds.add(orderId);
  }

  private isLive(orderId: OrderId): boolean {
    return this.index.has(orderId) || this.stops.some((s) => s.orderId === orderId);
  }

  private isOcoTerminal(orderId: OrderId): boolean {
    return this.ocoMembers.has(orderId) && !this.isLive(orderId);
  }

  private ocoTerminalIds(): string[] {
    return [...this.ocoMembers].filter((id) => !this.isLive(id)).sort();
  }

  private terminalAcceptedIds(): string[] {
    return [...this.acceptedIds].filter((id) => !this.isLive(id)).sort();
  }

  private rememberOco(order: { readonly orderId: OrderId; readonly ocoSiblingId?: OrderId | null }): void {
    if (!order.ocoSiblingId) return;
    this.ocoMembers.add(order.orderId);
  }

  private linkLiveSibling(orderId: OrderId, siblingId: OrderId | null): void {
    if (!siblingId) return;
    const rest = this.index.get(siblingId);
    if (rest && rest.ocoSiblingId === null) rest.ocoSiblingId = orderId;
    const stop = this.stops.find((s) => s.orderId === siblingId);
    if (stop && stop.ocoSiblingId === null) stop.ocoSiblingId = orderId;
    if (this.isLive(siblingId)) this.ocoMembers.add(siblingId);
  }

  private siblingOf(orderId: OrderId, incoming?: { readonly orderId: OrderId; readonly ocoSiblingId?: OrderId | null }): OrderId | null {
    if (incoming && incoming.orderId === orderId && incoming.ocoSiblingId) return incoming.ocoSiblingId;
    const rest = this.index.get(orderId);
    if (rest?.ocoSiblingId) return rest.ocoSiblingId;
    const stop = this.stops.find((s) => s.orderId === orderId);
    return stop?.ocoSiblingId ?? null;
  }

  private cancelOcoSiblings(
    fills: readonly Fill[],
    incoming?: { readonly orderId: OrderId; readonly ocoSiblingId?: OrderId | null; readonly type?: string },
  ): CancelledRef[] {
    const cancelled: CancelledRef[] = [];
    const fired = new Set<OrderId>();
    // A stop_limit that triggers and rests has no fill yet. The sibling is still live.
    if (fills.length === 0) {
      if (incoming?.type === 'stop_limit' && this.index.has(incoming.orderId)) {
        this.pullOcoLink(incoming.orderId, incoming, fired, cancelled);
      }
      return cancelled;
    }
    for (const fill of fills) {
      for (const id of [fill.makerOrderId, fill.takerOrderId]) {
        this.pullOcoLink(id, incoming, fired, cancelled);
      }
    }
    return cancelled;
  }

  private pullOcoLink(
    orderId: OrderId,
    incoming: { readonly orderId: OrderId; readonly ocoSiblingId?: OrderId | null } | undefined,
    fired: Set<OrderId>,
    cancelled: CancelledRef[],
  ): void {
    if (fired.has(orderId)) return;
    fired.add(orderId);
    const sibling = this.siblingOf(orderId, incoming);
    if (!sibling || fired.has(sibling)) return;
    const pulled = this.pullOcoSibling(sibling);
    if (pulled) {
      cancelled.push(pulled);
      fired.add(sibling);
      this.ocoMembers.add(sibling);
    }
    this.clearOcoLink(orderId);
  }

  private pullOcoSibling(orderId: OrderId): CancelledRef | null {
    const resting = this.index.get(orderId);
    if (resting) {
      this.removeResting(resting);
      const sequence = this.nextSequence();
      return {
        orderId,
        accountId: resting.accountId,
        remainingQty: resting.remaining,
        sequence,
        reason: 'oco_sibling_filled',
      };
    }
    const stopIndex = this.stops.findIndex((s) => s.orderId === orderId);
    if (stopIndex !== -1) {
      const stop = this.stops.splice(stopIndex, 1)[0] as StopOrder;
      const sequence = this.nextSequence();
      return { orderId, accountId: stop.accountId, remainingQty: stop.qty, sequence, reason: 'oco_sibling_filled' };
    }
    return null;
  }

  private clearOcoLink(orderId: OrderId): void {
    const rest = this.index.get(orderId);
    if (rest) rest.ocoSiblingId = null;
    const stop = this.stops.find((s) => s.orderId === orderId);
    if (stop) stop.ocoSiblingId = null;
  }

  private netPosition(accountId: AccountId): Amount {
    return this.positions.get(accountId) ?? ZERO;
  }

  /** Signed net after fills already taken in this match. The book net moves only in applyFillsToPosition. */
  private netAfterFills(accountId: AccountId, fills: readonly Fill[]): Amount {
    let net = this.netPosition(accountId);
    for (const fill of fills) {
      const signed = fill.takerSide === 'buy' ? fill.qty : -fill.qty;
      if (fill.takerAccountId === accountId) net += signed;
      if (fill.makerAccountId === accountId) net -= signed;
    }
    return net;
  }

  private openQty(net: Amount, side: OrderSide): Amount {
    if (side === 'sell') return net > ZERO ? net : ZERO;
    return net < ZERO ? -net : ZERO;
  }

  /** Live reduce-only qty on this side. exceptOrderId is the order being checked, so it is not reserved against itself. */
  private reservedReduceOnly(accountId: AccountId, side: OrderSide, exceptOrderId: OrderId | null): Amount {
    let reserved = ZERO;
    for (const resting of this.index.values()) {
      if (resting.reduceOnly && resting.accountId === accountId && resting.side === side && resting.orderId !== exceptOrderId) {
        reserved += resting.remaining;
      }
    }
    for (const stop of this.stops) {
      if (stop.reduceOnly && stop.accountId === accountId && stop.side === side && stop.orderId !== exceptOrderId) {
        reserved += stop.qty;
      }
    }
    return reserved;
  }

  private signedPosition(accountId: AccountId, override?: Amount | null): Amount {
    if (override !== undefined && override !== null) return override;
    if (this.futuresPositions.has(accountId)) return this.futuresPositions.get(accountId) ?? ZERO;
    return this.netPosition(accountId);
  }

  private reducibleQty(accountId: AccountId, side: OrderSide, exceptOrderId: OrderId | null = null): Amount {
    const open = this.openQty(this.signedPosition(accountId), side);
    const reserved = this.reservedReduceOnly(accountId, side, exceptOrderId);
    return open > reserved ? open - reserved : ZERO;
  }

  /**
   * Own size must fit the open qty after reduce-only rows that stay.
   * An untriggered stop always blocks. A market, stop, or stop-limit has no incoming price, so every same-side row blocks.
   */
  private incomingReduceOnlyRefused(order: EngineOrder): boolean {
    const open = this.openQty(this.signedPosition(order.accountId, order.positionQty), order.side);
    if (order.qty > open) return true;
    const blocking = this.reduceOnlyRows(order.accountId, order.side, order.orderId).filter(
      (row) => row.kind === 'stop' || !moreAggressive(order.side, incomingPrice(order), row.price),
    );
    let reserved = ZERO;
    for (const row of blocking) reserved += row.qty;
    return order.qty + reserved > open;
  }

  private displaceReduceOnly(order: EngineOrder): CancelledRef[] {
    if (order.reduceOnly !== true || incomingPrice(order) === null) return [];
    const open = this.openQty(this.signedPosition(order.accountId, order.positionQty), order.side);
    if (order.qty > open) return [];
    const rows = this.reduceOnlyRows(order.accountId, order.side, order.orderId);
    const less = rows.filter((row) => row.kind !== 'stop' && moreAggressive(order.side, incomingPrice(order), row.price));
    less.sort((a, b) => compareLeastAggressive(order.side, a, b));
    let reserved = ZERO;
    for (const row of rows) reserved += row.qty;
    const out: CancelledRef[] = [];
    for (const row of less) {
      if (order.qty + reserved <= open) break;
      const pulled = this.pullReduceOnlyRow(row);
      if (!pulled) continue;
      reserved -= row.qty;
      out.push(pulled);
    }
    return out;
  }

  private reduceOnlyRows(
    accountId: AccountId,
    side: OrderSide,
    exceptOrderId: OrderId,
  ): { orderId: OrderId; accountId: AccountId; qty: Amount; price: Amount | null; sequence: number; kind: 'book' | 'stop' }[] {
    const rows: { orderId: OrderId; accountId: AccountId; qty: Amount; price: Amount | null; sequence: number; kind: 'book' | 'stop' }[] =
      [];
    for (const resting of this.index.values()) {
      if (resting.reduceOnly && resting.accountId === accountId && resting.side === side && resting.orderId !== exceptOrderId) {
        rows.push({
          orderId: resting.orderId,
          accountId: resting.accountId,
          qty: resting.remaining,
          price: resting.price,
          sequence: resting.sequence,
          kind: 'book',
        });
      }
    }
    for (const stop of this.stops) {
      if (stop.reduceOnly && stop.accountId === accountId && stop.side === side && stop.orderId !== exceptOrderId) {
        rows.push({
          orderId: stop.orderId,
          accountId: stop.accountId,
          qty: stop.qty,
          price: stop.price ?? stop.stopPrice,
          sequence: stop.sequence,
          kind: 'stop',
        });
      }
    }
    return rows;
  }

  private pullReduceOnlyRow(row: { orderId: OrderId; kind: 'book' | 'stop' }): CancelledRef | null {
    if (row.kind === 'book') {
      const resting = this.index.get(row.orderId);
      if (!resting) return null;
      this.removeResting(resting);
      const sequence = this.nextSequence();
      return {
        orderId: resting.orderId,
        accountId: resting.accountId,
        remainingQty: resting.remaining,
        sequence,
        reason: 'reduce_only_displaced',
      };
    }
    const stopIndex = this.stops.findIndex((stop) => stop.orderId === row.orderId);
    if (stopIndex === -1) return null;
    const stop = this.stops.splice(stopIndex, 1)[0] as StopOrder;
    const sequence = this.nextSequence();
    return {
      orderId: stop.orderId,
      accountId: stop.accountId,
      remainingQty: stop.qty,
      sequence,
      reason: 'reduce_only_displaced',
    };
  }

  private drainReference(source: 'mark' | 'index', previous: Amount | null, next: Amount): TriggerOutcome[] {
    const outcomes: TriggerOutcome[] = [];
    for (;;) {
      const at = this.stops.findIndex(
        (stop) => stop.triggerBy === source && movedThrough(stop.side, stop.stopPrice, stop.triggerRole, previous, next),
      );
      if (at === -1) break;
      const stop = this.stops.splice(at, 1)[0] as StopOrder;
      outcomes.push(this.fire(stop, next));
    }
    return outcomes;
  }

  private wouldIncreasePosition(accountId: AccountId, side: OrderSide, qty: Amount, exceptOrderId: OrderId | null = null): boolean {
    return qty > this.reducibleQty(accountId, side, exceptOrderId);
  }

  /**
   * The live order an amend would patch. Null when the id is not resting or stopped.
   * Does not mutate. Inherited TIF matches amend: a post-only rest stays PO, otherwise GTC;
   * a stop keeps the TIF it was armed with.
   */
  amendTarget(orderId: OrderId): {
    readonly kind: 'book' | 'stop';
    readonly side: OrderSide;
    readonly price: Amount | null;
    readonly stopPrice: Amount | null;
    readonly inheritedTif: TimeInForce;
  } | null {
    const resting = this.index.get(orderId);
    if (resting) {
      return {
        kind: 'book',
        side: resting.side,
        price: resting.price,
        stopPrice: null,
        inheritedTif: resting.postOnly ? 'PO' : 'GTC',
      };
    }
    const stop = this.stops.find((row) => row.orderId === orderId);
    if (!stop) return null;
    return {
      kind: 'stop',
      side: stop.side,
      price: stop.price,
      stopPrice: stop.stopPrice,
      inheritedTif: stop.tif,
    };
  }

  /** True when a limit at this side and price would take the opposite top. Does not match. */
  wouldCrossLimit(side: OrderSide, price: Amount): boolean {
    return this.wouldCross(side, price);
  }

  /** True when a stop at this side and stop price would activate now. Does not activate. */
  stopWouldTrigger(side: OrderSide, stopPrice: Amount): boolean {
    if (this.lastTradePrice === null) return false;
    return side === 'buy' ? this.lastTradePrice >= stopPrice : this.lastTradePrice <= stopPrice;
  }

  /** Futures position for reduce-only. Zero is flat. Does not change the fill net. */
  noteFuturesPosition(accountId: AccountId, qty: Amount): void {
    this.futuresPositions.set(accountId, qty);
  }

  /** Same structural refusal as place, without resting, filling, or recording a position. */
  preview(incoming: EngineOrder): SubmitResult {
    const pegged = pegIntentRefuse(incoming);
    if (pegged) return rejected(pegged);
    const order = bindPegRelative(incoming);
    const structural = this.validate(order, null);
    if (structural) return rejected(structural);
    return { accepted: true, sequence: null, fills: [], resting: null, cancellations: [], triggered: [] };
  }

  /**
   * Mark or index reference. Null means the feed is missing or down: no stop fires,
   * and last is not copied in.
   */
  applyTriggerReference(source: 'mark' | 'index', price: Amount | null): TriggerOutcome[] {
    const previous = source === 'mark' ? this.markPrice : this.indexPrice;
    if (price === null || price <= ZERO) {
      if (source === 'mark') this.markPrice = null;
      else this.indexPrice = null;
      return [];
    }
    if (source === 'mark') this.markPrice = price;
    else this.indexPrice = price;
    return this.drainReference(source, previous, price);
  }

  /** Resting GTD/GTT ids already due. Does not cancel them. */
  dueExpiry(now: Date): OrderId[] {
    const nowMs = now.getTime();
    const due: OrderId[] = [];
    for (const order of this.index.values()) {
      if (order.expireAt && Date.parse(order.expireAt) <= nowMs) due.push(order.orderId);
    }
    for (const stop of this.stops) {
      if (stop.expireAt && Date.parse(stop.expireAt) <= nowMs) due.push(stop.orderId);
    }
    due.sort();
    return due;
  }

  /**
   * Remember the extreme a trailing stop follows. Does nothing when the stop
   * has no trail, or the peak is not positive — never invents either.
   */
  noteStopPeak(orderId: OrderId, peak: Amount): boolean {
    if (peak <= ZERO) return false;
    const stop = this.stops.find((row) => row.orderId === orderId);
    if (!stop || stop.trail === null || stop.trail <= ZERO) return false;
    stop.peak = peak;
    return true;
  }

  /** True if this qty on this side would open a flat or grow the net fill position. */
  wouldOpenOrIncrease(accountId: AccountId, side: OrderSide, qty: Amount, exceptOrderId: OrderId | null = null): boolean {
    return this.wouldIncreasePosition(accountId, side, qty, exceptOrderId);
  }

  /** Drop a reduce-only maker that no longer reduces. True when its price level is gone. */
  private pullReduceOnlyMaker(
    opposite: PriceLevel[],
    levelIndex: number,
    level: PriceLevel,
    maker: RestingOrder,
    cancellations: CancelledRef[],
  ): boolean {
    const sequence = this.nextSequence();
    cancellations.push({
      orderId: maker.orderId,
      accountId: maker.accountId,
      remainingQty: maker.remaining,
      sequence,
      reason: 'would_increase_position',
    });
    level.orders.shift();
    this.index.delete(maker.orderId);
    if (level.orders.length === 0) {
      opposite.splice(levelIndex, 1);
      return true;
    }
    return false;
  }

  private addPosition(accountId: AccountId, delta: Amount): void {
    const next = (this.positions.get(accountId) ?? ZERO) + delta;
    if (next === ZERO) this.positions.delete(accountId);
    else this.positions.set(accountId, next);
  }

  private applyFillsToPosition(fills: readonly Fill[]): void {
    for (const fill of fills) {
      const signed = fill.takerSide === 'buy' ? fill.qty : -fill.qty;
      this.addPosition(fill.takerAccountId, signed);
      this.addPosition(fill.makerAccountId, -signed);
    }
  }

  private futuresState(): { accountId: string; qty: string }[] {
    return [...this.futuresPositions.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([accountId, qty]) => ({ accountId, qty: formatAmount(qty) }));
  }

  private positionState(): { accountId: string; qty: string }[] {
    return [...this.positions.entries()]
      .filter(([, qty]) => qty !== ZERO)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([accountId, qty]) => ({ accountId, qty: formatAmount(qty) }));
  }

  private cancelReduceOnlyDue(): CancelledRef[] {
    const due: { orderId: OrderId; accountId: AccountId; remaining: Amount }[] = [];
    for (const o of this.index.values()) {
      if (o.reduceOnly && this.wouldIncreasePosition(o.accountId, o.side, o.remaining, o.orderId)) {
        due.push({ orderId: o.orderId, accountId: o.accountId, remaining: o.remaining });
      }
    }
    for (const s of this.stops) {
      if (s.reduceOnly && this.wouldIncreasePosition(s.accountId, s.side, s.qty, s.orderId)) {
        due.push({ orderId: s.orderId, accountId: s.accountId, remaining: s.qty });
      }
    }
    const out: CancelledRef[] = [];
    for (const row of due) {
      const resting = this.index.get(row.orderId);
      if (resting) {
        this.removeResting(resting);
        const sequence = this.nextSequence();
        out.push({
          orderId: row.orderId,
          accountId: resting.accountId,
          remainingQty: resting.remaining,
          sequence,
          reason: 'would_increase_position',
        });
        continue;
      }
      const stopIndex = this.stops.findIndex((s) => s.orderId === row.orderId);
      if (stopIndex !== -1) {
        const stop = this.stops.splice(stopIndex, 1)[0] as StopOrder;
        const sequence = this.nextSequence();
        out.push({
          orderId: row.orderId,
          accountId: stop.accountId,
          remainingQty: stop.qty,
          sequence,
          reason: 'would_increase_position',
        });
      }
    }
    return out;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  toState(): BookState {
    const foldLevels = (levels: readonly PriceLevel[]): PriceLevelState[] =>
      levels.map((level) => ({
        price: formatAmount(level.price),
        orders: level.orders.map((o) => ({
          orderId: o.orderId,
          accountId: o.accountId,
          remaining: formatAmount(o.remaining),
          sequence: o.sequence,
          version: o.version,
          ...(o.ocoSiblingId ? { ocoSiblingId: o.ocoSiblingId } : {}),
          ...(o.expireAt ? { expireAt: o.expireAt } : {}),
          ...(o.sessionId ? { sessionId: o.sessionId } : {}),
          ...(o.reduceOnly ? { reduceOnly: true } : {}),
          ...(o.postOnly ? { postOnly: true } : {}),
          ...(o.displayPeak !== null
            ? {
                displayQty: formatAmount(o.displayPeak),
                displayRemaining: formatAmount(o.displayRemaining as Amount),
              }
            : {}),
          ...(o.minQty !== null ? { minQty: formatAmount(o.minQty) } : {}),
          ...(o.aon ? { aon: true } : {}),
        })),
      }));

    return {
      marketId: this.marketId,
      sequence: this.sequence,
      lastTradePrice: this.lastTradePrice === null ? null : formatAmount(this.lastTradePrice),
      bids: foldLevels(this.bids),
      asks: foldLevels(this.asks),
      stops: this.stops.map((s) => ({
        orderId: s.orderId,
        accountId: s.accountId,
        type: s.type,
        side: s.side,
        qty: formatAmount(s.qty),
        price: s.price === null ? null : formatAmount(s.price),
        stopPrice: formatAmount(s.stopPrice),
        tif: s.tif,
        sequence: s.sequence,
        version: s.version,
        ...(s.ocoSiblingId ? { ocoSiblingId: s.ocoSiblingId } : {}),
        ...(s.expireAt ? { expireAt: s.expireAt } : {}),
        ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        ...(s.reduceOnly ? { reduceOnly: true } : {}),
        ...(s.triggerRole === 'take_profit' || s.triggerRole === 'stop_loss' ? { triggerRole: s.triggerRole } : {}),
        ...(s.triggerBy !== 'last' ? { triggerBy: s.triggerBy } : {}),
        ...(s.minQty !== null ? { minQty: formatAmount(s.minQty) } : {}),
        ...(s.aon ? { aon: true } : {}),
        ...(s.trail !== null && s.peak !== null ? { trail: formatAmount(s.trail), peak: formatAmount(s.peak) } : {}),
      })),
      ...(this.ocoTerminalIds().length > 0 ? { ocoTerminal: this.ocoTerminalIds() } : {}),
      ...(this.terminalAcceptedIds().length > 0 ? { acceptedOrderIds: this.terminalAcceptedIds() } : {}),
      ...(this.positionState().length > 0 ? { positions: this.positionState() } : {}),
      ...(this.futuresState().length > 0 ? { futuresPositions: this.futuresState() } : {}),
      ...(this.surveillanceCases.length > 0 ? { surveillanceCases: this.surveillanceCases } : {}),
    };
  }

  /**
   * An independent copy for rehearsal. `toState` is the durable form and leaves out the previous print and the
   * mark and index prices, so a bare `fromState(toState())` would rehearse against a book that reacts differently.
   */
  clone(): OrderBook {
    const copy = OrderBook.fromState(this.toState());
    copy.previousTradePrice = this.previousTradePrice;
    copy.markPrice = this.markPrice;
    copy.indexPrice = this.indexPrice;
    return copy;
  }

  serialize(): string {
    return JSON.stringify(this.toState());
  }

  static fromState(state: BookState): OrderBook {
    const book = new OrderBook(state.marketId);
    book.sequence = state.sequence;
    book.lastTradePrice = state.lastTradePrice === null ? null : parseAmount(state.lastTradePrice);

    const hydrate = (levels: readonly PriceLevelState[], side: OrderSide, target: PriceLevel[]): void => {
      for (const level of levels) {
        const price = parseAmount(level.price);
        const orders = level.orders.map<RestingOrder>((o) => ({
          orderId: o.orderId,
          accountId: o.accountId,
          side,
          price,
          remaining: parseAmount(o.remaining),
          sequence: o.sequence,
          version: o.version && o.version > 0 ? o.version : 1,
          ocoSiblingId: o.ocoSiblingId ?? null,
          expireAt: o.expireAt ?? null,
          sessionId: o.sessionId ?? null,
          reduceOnly: o.reduceOnly === true,
          postOnly: o.postOnly === true,
          displayPeak: o.displayQty == null ? null : parseAmount(o.displayQty),
          displayRemaining: o.displayRemaining == null ? null : parseAmount(o.displayRemaining),
          minQty: o.minQty == null ? null : parseAmount(o.minQty),
          aon: o.aon === true,
        }));
        for (const o of orders) book.index.set(o.orderId, o);
        target.push({ price, orders });
      }
    };

    hydrate(state.bids, 'buy', book.bids);
    hydrate(state.asks, 'sell', book.asks);

    for (const s of state.stops) {
      const walked = trailPeakState(s.trail, s.peak);
      book.stops.push({
        orderId: s.orderId,
        accountId: s.accountId,
        type: s.type as 'stop' | 'stop_limit',
        side: s.side,
        qty: parseAmount(s.qty),
        price: s.price === null ? null : parseAmount(s.price),
        stopPrice: parseAmount(s.stopPrice),
        tif: s.tif,
        sequence: s.sequence,
        version: s.version && s.version > 0 ? s.version : 1,
        ocoSiblingId: s.ocoSiblingId ?? null,
        expireAt: s.expireAt ?? null,
        sessionId: s.sessionId ?? null,
        reduceOnly: s.reduceOnly === true,
        triggerBy: s.triggerBy === 'mark' || s.triggerBy === 'index' ? s.triggerBy : 'last',
        triggerRole: s.triggerRole === 'take_profit' || s.triggerRole === 'stop_loss' ? s.triggerRole : 'legacy',
        minQty: s.minQty == null ? null : parseAmount(s.minQty),
        aon: s.aon === true,
        trail: walked.trail,
        peak: walked.peak,
      });
      if (s.ocoSiblingId) book.ocoMembers.add(s.orderId);
    }

    for (const level of [...book.bids, ...book.asks]) {
      for (const o of level.orders) {
        if (o.ocoSiblingId) book.ocoMembers.add(o.orderId);
      }
    }
    for (const id of state.ocoTerminal ?? []) book.ocoMembers.add(id);
    for (const id of state.acceptedOrderIds ?? []) book.acceptedIds.add(id);
    for (const id of book.index.keys()) book.acceptedIds.add(id);
    for (const stop of book.stops) book.acceptedIds.add(stop.orderId);

    for (const row of state.positions ?? []) {
      const qty = parseAmount(row.qty);
      if (qty !== ZERO) book.positions.set(row.accountId, qty);
    }
    for (const row of state.futuresPositions ?? []) {
      book.futuresPositions.set(row.accountId, parseAmount(row.qty));
    }

    for (const opened of state.surveillanceCases ?? []) {
      book.surveillanceCases.push({
        accountId: opened.accountId,
        marketId: opened.marketId,
        reason: opened.reason,
        status: 'open',
      });
    }

    return book;
  }
}

/** One shape for why a stop fired, whether it fired on the book or on arrival. */
function triggerFact(by: TriggerFact['by'], stopPrice: Amount, reference: Amount): TriggerFact {
  return { by, stopPrice, reference };
}

function collectSurveillance(fromMatch: readonly EngineSurveillanceCase[], triggered: readonly TriggerOutcome[]): EngineSurveillanceCase[] {
  const cases = [...fromMatch];
  for (const outcome of triggered) {
    if (outcome.surveillanceCases) cases.push(...outcome.surveillanceCases);
  }
  return cases;
}

function rejected(reason: RejectReason): SubmitResult {
  return { accepted: false, sequence: null, fills: [], resting: null, rejected: reason, cancellations: [], triggered: [] };
}

function refusedAmend(orderId: OrderId, reason: RejectReason): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: reason,
    cancellations: [],
    triggered: [],
  };
}

function toRestingRef(resting: RestingOrder): RestingRef {
  return {
    kind: 'book',
    orderId: resting.orderId,
    accountId: resting.accountId,
    side: resting.side,
    price: resting.price,
    remaining: resting.remaining,
    sequence: resting.sequence,
    version: resting.version,
  };
}

function toEffective(order: EngineOrder): EffectiveOrder {
  return {
    orderId: order.orderId,
    accountId: order.accountId,
    side: order.side,
    qty: order.qty,
    price: order.type === 'limit' || order.type === 'stop_limit' ? order.price : null,
    tif: order.tif,
    ocoSiblingId: order.ocoSiblingId ?? null,
    expireAt: order.expireAt ?? null,
    sessionId: readSessionId(order),
    reduceOnly: order.reduceOnly === true,
    displayQty: order.displayQty ?? null,
    minQty: readMinQty(order),
    aon: readAon(order),
  };
}

function crossesLevel(side: OrderSide, limitPrice: Amount, levelPrice: Amount): boolean {
  return side === 'buy' ? levelPrice <= limitPrice : levelPrice >= limitPrice;
}

function locate(levels: readonly PriceLevel[], price: Amount, descending: boolean): { position: number; found: boolean } {
  let lo = 0;
  let hi = levels.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = (levels[mid] as PriceLevel).price;
    if (p === price) return { position: mid, found: true };
    if (descending ? p > price : p < price) lo = mid + 1;
    else hi = mid;
  }

  return { position: lo, found: false };
}
