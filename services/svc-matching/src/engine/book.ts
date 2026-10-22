import { ZERO, formatAmount, min, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type {
  AccountId,
  AmendResult,
  BookState,
  CancelResult,
  CancelledRef,
  EngineAmend,
  EngineOrder,
  Fill,
  MarketId,
  OrderId,
  OrderSide,
  PriceLevelState,
  RejectReason,
  RestingRef,
  SubmitResult,
  TimeInForce,
  TriggerOutcome,
} from './types.js';

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
  reduceOnly: boolean;
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
  reduceOnly: boolean;
}

/**
 * An order reduced to what matching actually needs. A triggered stop becomes
 * one of these too, which is why activation and submission share a code path
 * instead of two implementations that drift apart.
 */
interface EffectiveOrder {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly side: OrderSide;
  readonly qty: Amount;
  /** null means "market" — take whatever the book offers. */
  readonly price: Amount | null;
  readonly tif: TimeInForce;
  readonly ocoSiblingId: OrderId | null;
  readonly expireAt: string | null;
  readonly reduceOnly: boolean;
}

interface MatchOutcome {
  readonly fills: Fill[];
  readonly remaining: Amount;
  readonly cancellations: CancelledRef[];
}

/**
 * Self-trade prevention policy: CANCEL-OLDEST.
 *
 * When an aggressor meets its own resting order, the resting order is pulled
 * and matching continues past it. The alternative — cancelling the incoming
 * remainder — lets an account wedge its own access to the book behind a stale
 * quote it has forgotten about. Cancel-oldest keeps the aggressor's intent and
 * costs the account only the order it had already decided to replace.
 *
 * Either way the invariant §5.1 cares about holds: no account is ever both
 * maker and taker of the same fill.
 */
export const SELF_TRADE_PREVENTION = 'cancel-oldest' as const;

function reject(code: RejectReason['code'], message: string): RejectReason {
  return { code, message };
}

export class OrderBook {
  readonly marketId: MarketId;

  private sequence = 0;
  /** Descending by price: index 0 is the best bid. */
  private readonly bids: PriceLevel[] = [];
  /** Ascending by price: index 0 is the best ask. */
  private readonly asks: PriceLevel[] = [];
  /** Acceptance order. `drainStops` scans it front-to-back, so this ordering is the trigger priority. */
  private readonly stops: StopOrder[] = [];
  private readonly index = new Map<OrderId, RestingOrder>();
  /** Order ids that joined an OCO pair. A named sibling that has left is terminal. */
  private readonly ocoMembers = new Set<OrderId>();
  private lastTradePrice: Amount | null = null;
  /** Net fill qty per account. Signed. Never a mark. */
  private readonly positions = new Map<AccountId, Amount>();

  /**
   * MEMOISED DEPTH — see `depth()` for the correctness argument.
   *
   * Derived state, not book state. `toState`/`fromState` ignore it on purpose:
   * a snapshot carrying a cache could restore a book whose cache disagreed with
   * its own orders, which is the one failure this must not be able to have.
   */
  private depthCache: { sequence: number; limit: number; bids: Array<[string, string]>; asks: Array<[string, string]> } | null = null;

  constructor(marketId: MarketId) {
    this.marketId = marketId;
  }

  // ── Read surface ──────────────────────────────────────────────────────

  get currentSequence(): number {
    return this.sequence;
  }

  get lastPrice(): Amount | null {
    return this.lastTradePrice;
  }

  /**
   * Never printed and holding nothing. Sequence can still be > 0: an IOC or
   * market remainder on a virgin book consumes a sequence without a print or a
   * rest. That must not list as a market — same honesty as a FOK reject.
   */
  get isNeverPrintedEmpty(): boolean {
    return this.lastTradePrice === null && this.index.size === 0 && this.stops.length === 0;
  }

  bestBid(): Amount | null {
    return this.bids[0]?.price ?? null;
  }

  bestAsk(): Amount | null {
    return this.asks[0]?.price ?? null;
  }

  /**
   * Aggregated depth, CCXT level shape: `[price, amount]` decimal-string tuples.
   *
   * ── WHY THIS IS MEMOISED ────────────────────────────────────────────────
   *
   * Measured (`pnpm perf:book`, 10k-deep book): depth was ~21k ops/s at p50
   * 44.8us against ~628k ops/s at p50 0.90us for a submit — fifty times the
   * cost of the write path. And svc-ws re-broadcasts depth on a loop, so the
   * read that runs most often was by far the most expensive thing the engine
   * did. The cost is not the summing; it is `formatAmount`, called 2x`limit`
   * times per call, each one a BigInt divide, a pad and a regex.
   *
   * ── WHY KEYED ON `sequence`, AND WHY THAT IS SOUND ──────────────────────
   *
   * `this.sequence` strictly increases on every operation that can change what
   * depth would report, and there is no mutating path that does not consume one:
   *
   *   · `submit`  — `nextSequence()` before `execute`, which is what fills,
   *                 rests and removes levels.
   *   · `cancel`  — `removeResting` then `nextSequence()`.
   *   · `amend`   — retain-priority still consumes one (remaining changed);
   *                 lose-priority re-executes through the same path as submit.
   *   · stops     — `drainStops` takes a sequence per trigger, and a trigger
   *                 executes through the same path.
   *   · restore   — `fromState` builds a NEW OrderBook, so it starts with an
   *                 empty cache rather than inheriting a stale one.
   *
   * Rejections (`validate`, PO/FOK viability) return BEFORE `nextSequence`,
   * and that is exactly right: a rejected order leaves the book untouched, so
   * the previous depth answer is still the correct one.
   *
   * So equal `sequence` means an unchanged book, and the cached answer is not
   * an approximation of the current one — it IS the current one.
   *
   * ── WHY NOT A RUNNING PER-LEVEL TOTAL ───────────────────────────────
   *
   * That was the faster option and it was rejected. It needs maintaining at
   * seven mutation sites, including the in-place `remaining` decrement inside a
   * partial fill. A total that drifts at any one of them reports WRONG DEPTH
   * to every caller, and nothing in the suite would notice: `toState` folds
   * from `orders`, not from a cached total, so journal-replay determinism would
   * stay byte-identical while the market data lied. One cache with one
   * invalidation rule can be reasoned about; seven hooks cannot.
   *
   * ── SHARING ─────────────────────────────────────────────────────────
   *
   * The outer arrays are fresh on every call. The `[price, amount]` tuples are
   * shared with the cache and must be treated as read-only — every caller
   * serialises them, none mutates them.
   */
  depth(limit = 50): { bids: Array<[string, string]>; asks: Array<[string, string]>; sequence: number } {
    const cached = this.depthCache;
    if (cached !== null && cached.sequence === this.sequence && cached.limit === limit) {
      return { bids: [...cached.bids], asks: [...cached.asks], sequence: this.sequence };
    }

    const fold = (levels: readonly PriceLevel[]): Array<[string, string]> =>
      levels.slice(0, limit).map((level) => {
        let total = ZERO;
        for (const order of level.orders) total += order.remaining;
        return [formatAmount(level.price), formatAmount(total)];
      });

    const bids = fold(this.bids);
    const asks = fold(this.asks);
    this.depthCache = { sequence: this.sequence, limit, bids, asks };

    return { bids: [...bids], asks: [...asks], sequence: this.sequence };
  }

  // ── Write surface ─────────────────────────────────────────────────────

  /**
   * Submit an order.
   *
   * Deterministic by construction: every branch below reads only the book's own
   * state and the order, and every sequence number comes from one counter.
   */
  submit(order: EngineOrder, now?: Date | null): SubmitResult {
    const structural = this.validate(order, now);
    if (structural) return rejected(structural);
    const expired = now != null ? this.expireDue(now) : [];

    // A stop that has not triggered yet never reaches the matcher, so its
    // PO/FOK viability is checked at activation instead — the book it will meet
    // is not the book it was submitted against.
    const isStop = order.type === 'stop' || order.type === 'stop_limit';
    const triggersNow = isStop && this.isTriggered(order.side, order.stopPrice as Amount);

    if (isStop && !triggersNow) {
      const sequence = this.nextSequence();
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
        reduceOnly: order.reduceOnly === true,
      });
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
        cancellations: expired,
        triggered: [],
      };
    }

    const effective = toEffective(order);

    // PO and FOK are decided BEFORE a sequence is consumed, because both are
    // rejections and a rejected order must leave the book — including its
    // counter — exactly as it found it.
    const viability = this.checkViability(effective);
    if (viability) return rejected(viability);

    const sequence = this.nextSequence();
    const outcome = this.execute(effective, sequence);
    this.recordPrints(outcome.fills);
    this.applyFillsToPosition(outcome.fills);
    const reduceCancels = this.cancelReduceOnlyDue();
    this.rememberOco(order);
    this.linkLiveSibling(order.orderId, order.ocoSiblingId ?? null);
    const ocoCancels = this.cancelOcoSiblings(outcome.fills, order);

    return {
      accepted: true,
      sequence,
      fills: outcome.fills,
      resting: outcome.resting,
      cancellations: [...expired, ...outcome.cancellations, ...reduceCancels, ...ocoCancels],
      triggered: this.drainStops(),
    };
  }

  /** Pull an order from the limit book or the stop book. Unknown ids are a no-op, not an error — cancels race fills. */
  cancel(orderId: OrderId): CancelResult {
    const resting = this.index.get(orderId);
    if (resting) {
      this.removeResting(resting);
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
          reason: 'requested',
        },
      };
    }

    const stopIndex = this.stops.findIndex((s) => s.orderId === orderId);
    if (stopIndex !== -1) {
      const stop = this.stops.splice(stopIndex, 1)[0] as StopOrder;
      const sequence = this.nextSequence();
      return {
        cancelled: true,
        orderId,
        sequence,
        cancellation: { orderId, accountId: stop.accountId, remainingQty: stop.qty, sequence, reason: 'requested' },
      };
    }

    return { cancelled: false, orderId, sequence: null, cancellation: null };
  }

  /**
   * Native amend (PX-S03 §8.2). One command against an expected instruction
   * version. Qty-down at the same price keeps the original queue sequence;
   * qty-up, price change, stop-price change, or a TIF that re-executes loses
   * it. A refuse does not pull the order.
   */
  amend(cmd: EngineAmend): AmendResult {
    const resting = this.index.get(cmd.orderId);
    if (resting) return this.amendResting(resting, cmd);

    const stop = this.stops.find((s) => s.orderId === cmd.orderId);
    if (stop) return this.amendStop(stop, cmd);

    return refusedAmend(cmd.orderId, reject('order_not_found', `order ${cmd.orderId} is not live in ${this.marketId}`));
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
    if (resting.reduceOnly && this.wouldIncreasePosition(resting.accountId, resting.side, qty)) {
      return refusedAmend(
        cmd.orderId,
        reject('would_increase_position', 'reduce-only refuses a qty that would increase the position; the engine does not invent a mark'),
      );
    }

    const tif: TimeInForce = cmd.tif ?? 'GTC';
    const tifForcesReexecute = tif === 'IOC' || tif === 'FOK';
    const retain = price === resting.price && !tifForcesReexecute && qty <= resting.remaining;

    if (retain) {
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
      reduceOnly: resting.reduceOnly,
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
    return {
      accepted: true,
      orderId: cmd.orderId,
      sequence: outcome.resting?.sequence ?? sequence,
      version: outcome.resting?.version ?? nextVersion,
      priority: 'lost',
      fills: outcome.fills,
      resting: outcome.resting,
      cancellations: [...outcome.cancellations, ...reduceCancels, ...ocoCancels],
      triggered: this.drainStops(),
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

    const tifForcesReexecute = tif === 'IOC' || tif === 'FOK';
    const sameLimit = (price === null && stop.price === null) || (price !== null && stop.price !== null && price === stop.price);
    const retain = stopPrice === stop.stopPrice && sameLimit && tif === stop.tif && !tifForcesReexecute && qty <= stop.qty;

    if (retain) {
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
      reduceOnly: updated.reduceOnly,
    };

    if (this.isTriggered(updated.side, updated.stopPrice)) {
      const viability = this.checkViability(effective);
      if (viability) return refusedAmend(cmd.orderId, viability);
      const at = this.stops.findIndex((s) => s.orderId === stop.orderId);
      if (at !== -1) this.stops.splice(at, 1);
      const triggered = this.activate(updated);
      return {
        accepted: true,
        orderId: cmd.orderId,
        sequence: triggered.resting?.sequence ?? triggered.sequence,
        version: triggered.resting?.version ?? updated.version,
        priority: 'lost',
        fills: triggered.fills,
        resting: triggered.resting,
        cancellations: triggered.cancellations,
        triggered: [triggered, ...this.drainStops()],
        rejected: triggered.rejected,
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

  // ── Validation ────────────────────────────────────────────────────────

  private validate(order: EngineOrder, now?: Date | null): RejectReason | null {
    if (order.qty <= ZERO) return reject('invalid_qty', 'quantity must be strictly positive');
    if (this.index.has(order.orderId) || this.stops.some((s) => s.orderId === order.orderId)) {
      // Bots retry. A retry that opens a second position is the worst bug this
      // service could have, so the id is the guard rather than a hope.
      return reject('duplicate_order_id', `order ${order.orderId} is already live in ${this.marketId}`);
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
      if (order.price <= ZERO) return reject('invalid_price', 'price must be strictly positive');
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

    // Post-only is a promise to be a maker. An order that cannot rest cannot
    // make that promise, so the combination is refused rather than reinterpreted.
    if (order.tif === 'PO' && !needsPrice) {
      return reject('invalid_tif', 'post-only requires a limit price');
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

    if (order.reduceOnly === true) {
      if (this.wouldIncreasePosition(order.accountId, order.side, order.qty)) {
        return reject(
          'would_increase_position',
          'reduce-only refuses a qty that would increase the position; the engine does not invent a mark',
        );
      }
    }

    return null;
  }

  /** Pull every GTD/GTT whose expireAt is due on `now`. Clock is an argument; the book never reads one. */
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

  /**
   * Book-state-dependent rejections. Non-mutating on purpose: FOK must be able
   * to ask "would this fill completely?" without half-filling to find out.
   */
  private checkViability(order: EffectiveOrder): RejectReason | null {
    if (order.tif === 'PO' && order.price !== null && this.wouldCross(order.side, order.price)) {
      return reject('post_only_would_cross', 'post-only order would take liquidity');
    }

    if (order.tif === 'FOK' && this.fillableQty(order.side, order.price, order.accountId) < order.qty) {
      // §5.1: fill-or-kill is all or nothing. No partial, not even one unit.
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

  /**
   * How much of the opposing book this account could actually take.
   *
   * Its own resting orders are excluded: self-trade prevention will pull them
   * rather than fill against them, so counting them would let a FOK order pass
   * a check it cannot satisfy.
   */
  private fillableQty(side: OrderSide, limitPrice: Amount | null, accountId: AccountId): Amount {
    let total = ZERO;
    for (const level of side === 'buy' ? this.asks : this.bids) {
      if (limitPrice !== null && !crossesLevel(side, limitPrice, level.price)) break;
      for (const order of level.orders) {
        if (order.accountId === accountId) continue;
        total += order.remaining;
      }
    }
    return total;
  }

  // ── Matching ──────────────────────────────────────────────────────────

  private execute(
    order: EffectiveOrder,
    sequence: number,
    version = 1,
  ): { fills: Fill[]; resting: RestingRef | null; cancellations: CancelledRef[] } {
    const matched = this.match(order);
    const cancellations = matched.cancellations;
    let resting: RestingRef | null = null;

    if (matched.remaining > ZERO) {
      const canRest = order.price !== null && (order.tif === 'GTC' || order.tif === 'PO' || order.tif === 'GTD' || order.tif === 'GTT');
      if (canRest) {
        resting = this.rest(order, matched.remaining, sequence, version);
      } else {
        cancellations.push({
          orderId: order.orderId,
          accountId: order.accountId,
          remainingQty: matched.remaining,
          sequence: this.nextSequence(),
          // A market order can never rest, whatever TIF it carried; an IOC limit
          // chose not to. svc-trade releases the hold identically for both, but
          // the reason is what a support ticket is answered with.
          reason: order.price === null ? 'market_remainder' : 'ioc_remainder',
        });
      }
    }

    return { fills: matched.fills, resting, cancellations };
  }

  /**
   * Walk the opposing book best-price-first, FIFO within a price level.
   *
   * This is price-time priority in five lines, and everything else in the file
   * exists to keep those five lines honest.
   */
  private match(order: EffectiveOrder): MatchOutcome {
    const opposite = order.side === 'buy' ? this.asks : this.bids;
    const fills: Fill[] = [];
    const cancellations: CancelledRef[] = [];
    let remaining = order.qty;

    while (remaining > ZERO && opposite.length > 0) {
      const level = opposite[0] as PriceLevel;
      if (order.price !== null && !crossesLevel(order.side, order.price, level.price)) break;

      while (remaining > ZERO && level.orders.length > 0) {
        const maker = level.orders[0] as RestingOrder;

        if (maker.accountId === order.accountId) {
          level.orders.shift();
          this.index.delete(maker.orderId);
          cancellations.push({
            orderId: maker.orderId,
            accountId: maker.accountId,
            remainingQty: maker.remaining,
            sequence: this.nextSequence(),
            reason: 'self_trade_prevention',
          });
          continue;
        }

        const qty = min(remaining, maker.remaining);
        fills.push({
          sequence: this.nextSequence(),
          makerOrderId: maker.orderId,
          makerAccountId: maker.accountId,
          takerOrderId: order.orderId,
          takerAccountId: order.accountId,
          takerSide: order.side,
          // The maker's price, always. The taker crossed the spread; it does not
          // also get to set the price it crossed to.
          price: maker.price,
          qty,
        });

        maker.remaining -= qty;
        remaining -= qty;

        if (maker.remaining === ZERO) {
          level.orders.shift();
          this.index.delete(maker.orderId);
        }
      }

      // A level that emptied exactly leaves the book here, not on the next pass:
      // an empty level must never be observable as the best price.
      if (level.orders.length === 0) opposite.shift();
    }

    return { fills, remaining, cancellations };
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
      reduceOnly: order.reduceOnly,
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

  // ── Stops ─────────────────────────────────────────────────────────────

  private recordPrints(fills: readonly Fill[]): void {
    const last = fills[fills.length - 1];
    if (last) this.lastTradePrice = last.price;
  }

  /** A buy stop fires when the market trades up to it; a sell stop when it trades down to it. */
  private isTriggered(side: OrderSide, stopPrice: Amount): boolean {
    if (this.lastTradePrice === null) return false;
    return side === 'buy' ? this.lastTradePrice >= stopPrice : this.lastTradePrice <= stopPrice;
  }

  /**
   * Fire every stop the latest prints armed, cascading.
   *
   * Terminates because each pass removes exactly one order from `this.stops`
   * and nothing in the loop puts one back. Order is by acceptance sequence:
   * the oldest armed stop goes first, which is the same tie-break the limit
   * book uses.
   */
  private drainStops(): TriggerOutcome[] {
    const outcomes: TriggerOutcome[] = [];

    for (;;) {
      const at = this.stops.findIndex((s) => this.isTriggered(s.side, s.stopPrice));
      if (at === -1) break;
      const stop = this.stops.splice(at, 1)[0] as StopOrder;
      outcomes.push(this.activate(stop));
    }

    return outcomes;
  }

  private activate(stop: StopOrder): TriggerOutcome {
    const effective: EffectiveOrder = {
      orderId: stop.orderId,
      accountId: stop.accountId,
      side: stop.side,
      qty: stop.qty,
      // A stop-market becomes a market order; a stop-limit becomes its limit.
      price: stop.type === 'stop_limit' ? stop.price : null,
      tif: stop.tif,
      ocoSiblingId: stop.ocoSiblingId,
      expireAt: stop.expireAt,
      reduceOnly: stop.reduceOnly,
    };

    // Viability BEFORE a sequence is taken — same rule as submit(). A pure
    // structural reject must not invent two sequences for a path that never
    // filled or rested. The stop was already pulled from the stop book, so the
    // cancel still needs one sequence (depth memo keys on sequence; removing a
    // stop is a real mutation), and that single sequence is both the outcome
    // sequence and the cancellation sequence.
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

    const sequence = this.nextSequence();
    const outcome = this.execute(effective, sequence, stop.version);
    // Prints from a triggered stop arm the next one — that is the cascade.
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
    };
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

  /**
   * First fill of either OCO leg pulls the sibling. Runs after prints are
   * recorded and before drainStops, so a linked stop does not also fire.
   */
  private cancelOcoSiblings(
    fills: readonly Fill[],
    incoming?: { readonly orderId: OrderId; readonly ocoSiblingId?: OrderId | null },
  ): CancelledRef[] {
    if (fills.length === 0) return [];
    const cancelled: CancelledRef[] = [];
    const fired = new Set<OrderId>();
    for (const fill of fills) {
      for (const id of [fill.makerOrderId, fill.takerOrderId]) {
        if (fired.has(id)) continue;
        fired.add(id);
        const sibling = this.siblingOf(id, incoming);
        if (!sibling || fired.has(sibling)) continue;
        const pulled = this.pullOcoSibling(sibling);
        if (pulled) {
          cancelled.push(pulled);
          fired.add(sibling);
          this.ocoMembers.add(sibling);
        }
        this.clearOcoLink(id);
      }
    }
    return cancelled;
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

  private reducibleQty(accountId: AccountId, side: OrderSide): Amount {
    const net = this.netPosition(accountId);
    if (side === 'sell') return net > ZERO ? net : ZERO;
    return net < ZERO ? -net : ZERO;
  }

  private wouldIncreasePosition(accountId: AccountId, side: OrderSide, qty: Amount): boolean {
    return qty > this.reducibleQty(accountId, side);
  }

  private addPosition(accountId: AccountId, delta: Amount): void {
    const next = (this.positions.get(accountId) ?? ZERO) + delta;
    if (next === ZERO) this.positions.delete(accountId);
    else this.positions.set(accountId, next);
  }

  /** Position is net fills. Never a mark. */
  private applyFillsToPosition(fills: readonly Fill[]): void {
    for (const fill of fills) {
      const signed = fill.takerSide === 'buy' ? fill.qty : -fill.qty;
      this.addPosition(fill.takerAccountId, signed);
      this.addPosition(fill.makerAccountId, -signed);
    }
  }

  private positionState(): { accountId: string; qty: string }[] {
    return [...this.positions.entries()]
      .filter(([, qty]) => qty !== ZERO)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([accountId, qty]) => ({ accountId, qty: formatAmount(qty) }));
  }

  /** Pull every reduce-only rest that would now increase the position. */
  private cancelReduceOnlyDue(): CancelledRef[] {
    const due: { orderId: OrderId; accountId: AccountId; remaining: Amount }[] = [];
    for (const o of this.index.values()) {
      if (o.reduceOnly && this.wouldIncreasePosition(o.accountId, o.side, o.remaining)) {
        due.push({ orderId: o.orderId, accountId: o.accountId, remaining: o.remaining });
      }
    }
    for (const s of this.stops) {
      if (s.reduceOnly && this.wouldIncreasePosition(s.accountId, s.side, s.qty)) {
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

  // ── Serialisation (§5.4) ──────────────────────────────────────────────

  /**
   * The whole book as plain data. Every amount is a decimal string.
   *
   * Key order is fixed by these object literals, so `JSON.stringify` of two
   * equal books is byte-identical — which is exactly what §5.4's determinism
   * test compares.
   */
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
          ...(o.reduceOnly ? { reduceOnly: true } : {}),
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
        ...(s.reduceOnly ? { reduceOnly: true } : {}),
      })),
      ...(this.ocoTerminalIds().length > 0 ? { ocoTerminal: this.ocoTerminalIds() } : {}),
      ...(this.positionState().length > 0 ? { positions: this.positionState() } : {}),
    };
  }

  serialize(): string {
    return JSON.stringify(this.toState());
  }

  /** Rebuild a book from a snapshot. The inverse of `toState`, unit for unit. */
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
          reduceOnly: o.reduceOnly === true,
        }));
        for (const o of orders) book.index.set(o.orderId, o);
        target.push({ price, orders });
      }
    };

    hydrate(state.bids, 'buy', book.bids);
    hydrate(state.asks, 'sell', book.asks);

    for (const s of state.stops) {
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
        reduceOnly: s.reduceOnly === true,
      });
      if (s.ocoSiblingId) book.ocoMembers.add(s.orderId);
    }

    for (const level of [...book.bids, ...book.asks]) {
      for (const o of level.orders) {
        if (o.ocoSiblingId) book.ocoMembers.add(o.orderId);
      }
    }
    for (const id of state.ocoTerminal ?? []) book.ocoMembers.add(id);

    for (const row of state.positions ?? []) {
      const qty = parseAmount(row.qty);
      if (qty !== ZERO) book.positions.set(row.accountId, qty);
    }

    return book;
  }
}

// ── Free functions ──────────────────────────────────────────────────────

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
    reduceOnly: order.reduceOnly === true,
  };
}

/** Would an aggressor at `limitPrice` accept a resting order at `levelPrice`? */
function crossesLevel(side: OrderSide, limitPrice: Amount, levelPrice: Amount): boolean {
  return side === 'buy' ? levelPrice <= limitPrice : levelPrice >= limitPrice;
}

/**
 * Binary search over the sorted level array.
 *
 * Levels are kept in an array rather than a Map because iteration order over a
 * Map is insertion order, not price order — and a book whose "best price"
 * depends on what was inserted first is not a book (§5.4).
 */
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
