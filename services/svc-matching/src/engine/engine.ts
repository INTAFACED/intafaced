import { ZERO, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { MarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import type { EventBus, PayloadOf } from '@intafaced/events';
import { publishedEngineL2Limit } from '../l2-limit.js';
import { publishWithStartupRetry } from '../startup-publish.js';
import { withEngineSpan, withSpan } from '../tracing.js';
import { OrderBook } from './book.js';
import { unsupportedAmendField } from './amend-priority.js';
import { applyMark as walkTrailingStops, markRefuse } from './trailing-stop.js';
import './option.js';
import {
  installSpreadBook,
  isSpreadBook,
  outrightOnSpreadRefuse,
  spreadFillEvent,
  spreadFillKey,
  spreadOrderRefuse,
  type SpreadFillEvent,
  type SpreadFillPublisher,
} from './spread-book.js';
import { fromWireSpread, readSpreadListing, spreadIdentity, toWireSpread, type SpreadListingInput } from './spread-instrument.js';
import { flattenCloseOrder, netPositionOf, positionFlatResult, type ClosePositionCommand } from './close-position.js';
import {
  dualControlRefuse,
  haltedAmendResult,
  haltedSubmitResult,
  operatorRefuse,
  readConfirmOperatorId,
  readOperatorId,
  replayHaltedMarkets,
  replayHaltedSince,
} from './halt.js';
import { replayVenueHalted, replayVenueHaltedSince, venueHaltedAmendResult, venueHaltedSubmitResult } from './venue-kill.js';
import {
  reduceOnlyMarketAmendResult,
  reduceOnlyMarketSubmitResult,
  replayReduceOnlyMarkets,
  wouldOpenOrIncrease,
} from './reduce-only-market.js';
import { isPostOnlySubmit, postOnlyAmendRefusal, postOnlyMarketSubmitResult, replayPostOnlyMarkets } from './post-only-market.js';
import { prelaunchAmendResult, prelaunchSubmitResult, replayOpenedMarkets, replayPrelaunchMarkets } from './prelaunch.js';
import {
  delistedAmendResult,
  delistedSubmitResult,
  expiredAmendResult,
  expiredSubmitResult,
  replayDelistedMarkets,
  replayExpiredMarkets,
} from './expire.js';
import { maintenanceAmendResult, maintenanceSubmitResult, replayMaintenance, maintenanceRefuse } from './maintenance.js';
import {
  inFlightAmendResult,
  inFlightCancelResult,
  inFlightSubmitResult,
  parseIfmQty,
  replayInFlight,
  type IfmMutation,
  type InFlightMark,
} from './ifm.js';
import { massCancelSessionRefuse, readMassCancelSide, readSessionId } from './mass-cancel.js';
import { missingSessionRefuse, replayDeadSessions, sessionGoneSubmitResult } from './session.js';
import {
  replayJournal,
  serializeBooks,
  snapshotAll,
  toWire,
  toWireAmend,
  type EngineJournal,
  type EngineSnapshot,
  type JournalRecord,
} from './journal.js';
import type {
  AmendResult,
  MarkResult,
  CancelReason,
  CancelResult,
  CancelledRef,
  EngineAmend,
  EngineLiveOrder,
  EngineOrder,
  RestingHoldSubject,
  EngineSurveillanceCase,
  Fill,
  MarketHaltResult,
  MarketMaintenanceResult,
  ExpirySweepResult,
  MarketId,
  MarketPostOnlyResult,
  MarketDelistResult,
  MarketExpireResult,
  MarketPrelaunchResult,
  MarketReduceOnlyResult,
  MassCancelResult,
  SessionDeadResult,
  SpreadInstrument,
  RejectReason,
  VenueKillResult,
  OrderId,
  OrderSide,
  PriceLevelState,
  SubmitResult,
  TriggerFact,
  TriggerOutcome,
} from './types.js';

export { OrderBook };

/**
 * THE MATCHING ENGINE (§5.1).
 *
 * Books per market, the journal in front of them, and the event stream out the
 * back. Everything the engine does that is not pure matching lives here, so
 * `book.ts` can stay a pure function of (state, order) — the property §5.4's
 * determinism test rests on.
 *
 * What this service does NOT do, and must never start doing:
 *   - hold a balance (Doctrine §0.6 — the ledger is the only place one exists)
 *   - post a ledger transaction (svc-trade turns `orderFilled` into a
 *     `tradeFill` recipe; the engine never sees an asset, a fee, or a user)
 *   - validate that an account can afford an order (§5.1: orders arrive
 *     pre-validated, held funds and all)
 *
 * It speaks in account ids and quantities and nothing else.
 */

/** Where periodic book snapshots go. §5.1: "Snapshot every N events to Redis for ws-gateway depth streaming". */
export interface SnapshotSink {
  write(snapshot: EngineSnapshot): Promise<void> | void;
}

/** Default sink: keeps the last snapshot in memory so `/ready` and tests can see one without Redis. */
export class MemorySnapshotSink implements SnapshotSink {
  latest: EngineSnapshot | null = null;

  write(snapshot: EngineSnapshot): void {
    this.latest = snapshot;
  }
}

export interface MatchingEngineOptions {
  readonly journal: EngineJournal;
  readonly bus: EventBus;
  /**
   * Injected so replay is reproducible. The book never reads a clock; only
   * event payloads carry a timestamp, and that timestamp is journalled.
   */
  readonly clock?: () => Date;
  /**
   * Snapshot cadence. Required. Unset refuses (never invent 500).
   * Owner-explicit 0 disables snapshotting.
   */
  readonly snapshotEvery: number;
  readonly snapshotSink?: SnapshotSink;
  /** Kill-switch mirror of the `matching.engine` flag (§14 admin controls). */
  readonly enabled?: boolean;
  /** Startup publish backoff. Tests pass a no-op. Production waits. */
  readonly startupSleep?: (ms: number) => Promise<void>;
  /**
   * Spread fill announcements (CB-otc-16); production passes `spreadFillPublisherFor(bus)` (`matching.spread.filled`).
   * Unset, spread orders refuse `spread_fill_event_unwired` before they are journalled.
   */
  readonly spreadFills?: SpreadFillPublisher;
}

type PendingEvent =
  | { readonly sequence: number; readonly name: 'orderAccepted'; readonly payload: PayloadOf<'orderAccepted'>; readonly key: string }
  | { readonly sequence: number; readonly name: 'orderFilled'; readonly payload: PayloadOf<'orderFilled'>; readonly key: string }
  | { readonly sequence: number; readonly name: 'orderCancelled'; readonly payload: PayloadOf<'orderCancelled'>; readonly key: string }
  | { readonly sequence: number; readonly name: 'orderTriggered'; readonly payload: PayloadOf<'orderTriggered'>; readonly key: string }
  | { readonly sequence: number; readonly name: 'spreadFilled'; readonly payload: SpreadFillEvent; readonly key: string };

/**
 * Who asks for an emergency action (halt, resume, halt-all, resume-all, expire), who confirmed it, and its evidence.
 * The engine reads the two operators; the rulebook wrapper (rulebook-refuse.ts) refuses one without evidence.
 */
export type EmergencyCmd = {
  readonly operatorId?: string | null;
  readonly confirmOperatorId?: string | null;
  readonly evidence?: string | null;
  readonly evidenceRefs?: readonly unknown[] | null;
};

export class MatchingEngine {
  private readonly books = new Map<MarketId, OrderBook>();
  private readonly journal: EngineJournal;
  private readonly bus: EventBus;
  private readonly clock: () => Date;
  /** Set only when a clock was injected. GTD/GTT refuse when this is missing. */
  private readonly expiryClock: (() => Date) | null;
  private readonly snapshotEvery: number;
  private readonly sink: SnapshotSink;
  private enabled: boolean;
  /** One-market operator halt. Not the process kill-switch. No duration. */
  private readonly halted = new Set<MarketId>();
  /** When each halted market's halt began (the journaled `at` of its first halt since the last resume). */
  private readonly haltedSince = new Map<MarketId, string>();
  /** One-market maintenance. Not halt. Customer cancels refuse. No duration. */
  private readonly maintenance = new Set<MarketId>();
  /** Books the expiry pass must not read. The resting order stays. */
  private readonly unreadableBooks = new Map<MarketId, string>();
  /** Operator halt of every market. Distinct from one-market halt. No duration. */
  private venueHalted = false;
  /** When the venue halt began (the journaled `at` of its first halt-all since the last resume-all); null when open. */
  private venueHaltedAt: string | null = null;
  /** One-market operator reduce-only. Not halt. No duration. */
  private readonly reduceOnlyMarkets = new Set<MarketId>();
  /** One-market operator post-only. Not halt. No duration. */
  private readonly postOnlyMarkets = new Set<MarketId>();
  /** One-market operator prelaunch. Public submits refuse until OPEN. Not halt. No duration. */
  private readonly prelaunchMarkets = new Set<MarketId>();
  /**
   * Markets an approved (dual-control) OPEN has listed. Listed means visible in
   * `markets` even with no book, so svc-trade can send the first order. A book
   * is still only created by a submit. Expired/delisted markets are not listed.
   */
  private readonly listedMarkets = new Set<MarketId>();
  /** One-market operator expire. New submits refuse. Cancels stay. Not halt. No notice period. */
  private readonly expiredMarkets = new Set<MarketId>();
  /** One-market operator delist. New submits refuse. Cancels stay. Not halt. No notice period. */
  private readonly delistedMarkets = new Set<MarketId>();
  /** Dead sessions. Tagged submits refuse. Tagged rests cancel on session-dead. Not mass-cancel. */
  private readonly deadSessions = new Set<string>();
  /** Unconfirmed amend/cancel. Second live rest or duplicate fill for that id refuses. */
  private readonly inFlight = new Map<OrderId, InFlightMark>();
  /**
   * Set for the whole book when the replay hold check cannot be asked.
   * Not a journal halt: the next boot asks again. While set, nothing matches.
   */
  private admissionClosed: string | null = null;
  /** One market, when a bad hold could not be cancelled. Not an operator halt. */
  private readonly holdHalted = new Map<MarketId, string>();
  /** True from recover() until finishStartupAnnounce(). Publishes retry on TIMEOUT. */
  private announcing = false;
  private readonly startupSleep: (ms: number) => Promise<void>;
  /** Owner spread listings, rebuilt from `spread_list` journal records. Empty means nothing is listed. */
  private readonly spreads = new Map<MarketId, SpreadInstrument>();
  private readonly spreadFills: SpreadFillPublisher | null;

  constructor(options: MatchingEngineOptions) {
    this.journal = options.journal;
    this.bus = options.bus;
    this.clock = options.clock ?? (() => new Date());
    this.expiryClock = options.clock ?? null;
    this.snapshotEvery = publishedSnapshotEvery(options.snapshotEvery);
    this.sink = options.snapshotSink ?? new MemorySnapshotSink();
    this.enabled = options.enabled ?? true;
    this.startupSleep = options.startupSleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.spreadFills = options.spreadFills ?? null;
    // After every module has loaded, so the hitch wraps the finished OrderBook. Idempotent.
    installSpreadBook();
  }

  /**
   * Rebuild books from journalled inputs, then republish recovered fills with
   * the original sequence idempotency keys. Does not invent fills.
   */
  async recover(): Promise<{ records: number; markets: number }> {
    const records: readonly JournalRecord[] = this.journal.read();
    this.books.clear();
    this.halted.clear();
    this.haltedSince.clear();
    this.maintenance.clear();
    this.unreadableBooks.clear();
    this.admissionClosed = null;
    this.holdHalted.clear();
    this.announcing = true;
    this.venueHalted = false;
    this.venueHaltedAt = null;
    this.reduceOnlyMarkets.clear();
    this.postOnlyMarkets.clear();
    this.prelaunchMarkets.clear();
    this.listedMarkets.clear();
    this.expiredMarkets.clear();
    this.delistedMarkets.clear();
    this.deadSessions.clear();
    this.inFlight.clear();
    this.spreads.clear();
    for (const record of records) {
      if (record.kind === 'spread_list' && !this.spreads.has(record.marketId)) {
        this.spreads.set(record.marketId, fromWireSpread(record.instrument));
      }
    }
    const replayed = replayJournal(records);
    for (const [marketId, book] of replayed.books) this.books.set(marketId, book);
    this.venueHalted = replayVenueHalted(records);
    this.venueHaltedAt = replayVenueHaltedSince(records);
    for (const marketId of replayHaltedMarkets(records)) this.halted.add(marketId);
    for (const [marketId, at] of replayHaltedSince(records)) this.haltedSince.set(marketId, at);
    for (const marketId of replayMaintenance(records)) this.maintenance.add(marketId);
    for (const marketId of replayReduceOnlyMarkets(records)) this.reduceOnlyMarkets.add(marketId);
    for (const marketId of replayPostOnlyMarkets(records)) this.postOnlyMarkets.add(marketId);
    for (const marketId of replayPrelaunchMarkets(records)) this.prelaunchMarkets.add(marketId);
    for (const marketId of replayOpenedMarkets(records)) this.listedMarkets.add(marketId);
    for (const marketId of replayExpiredMarkets(records)) this.expiredMarkets.add(marketId);
    for (const marketId of replayDelistedMarkets(records)) this.delistedMarkets.add(marketId);
    for (const sessionId of replayDeadSessions(records)) this.deadSessions.add(sessionId);
    for (const [orderId, mark] of replayInFlight(records)) this.inFlight.set(orderId, mark);
    const announced = [
      ...replayed.fills.map((row) => fillEvent(row.marketId, row.fill, row.at)),
      ...replayed.holdCancels.map((row) => cancelledEvent(row.marketId, row.cancellation)),
      ...replayed.triggers.map((row) => triggeredEvent(row.marketId, row.orderId, row.sequence, row.trigger, row.at)),
    ];
    announced.sort((a, b) => a.sequence - b.sequence);
    await this.emit(announced);
    return { records: records.length, markets: this.books.size };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  isMaintenance(marketId: MarketId): boolean {
    return this.maintenance.has(marketId);
  }

  /** The expiry pass skips this book and records the reason. The order stays. */
  noteBookUnreadable(marketId: MarketId, reason: string): void {
    const trimmed = reason.trim();
    if (trimmed.length === 0) return;
    this.unreadableBooks.set(marketId, trimmed);
  }

  isHalted(marketId: MarketId): boolean {
    return this.halted.has(marketId);
  }

  get isVenueHalted(): boolean {
    return this.venueHalted;
  }

  /** When this market's operator halt began, or null when it is not halted. */
  haltedSinceOf(marketId: MarketId): string | null {
    return this.halted.has(marketId) ? (this.haltedSince.get(marketId) ?? null) : null;
  }

  /** When the venue halt began, or null when the venue is open. */
  get venueHaltedSince(): string | null {
    return this.venueHalted ? this.venueHaltedAt : null;
  }

  isReduceOnly(marketId: MarketId): boolean {
    return this.reduceOnlyMarkets.has(marketId);
  }

  isPostOnly(marketId: MarketId): boolean {
    return this.postOnlyMarkets.has(marketId);
  }

  isPrelaunch(marketId: MarketId): boolean {
    return this.prelaunchMarkets.has(marketId);
  }

  isExpired(marketId: MarketId): boolean {
    return this.expiredMarkets.has(marketId);
  }

  isDelisted(marketId: MarketId): boolean {
    return this.delistedMarkets.has(marketId);
  }

  isSessionDead(sessionId: string): boolean {
    return this.deadSessions.has(sessionId);
  }

  book(marketId: MarketId): OrderBook {
    let book = this.books.get(marketId);
    if (!book) {
      book = new OrderBook(marketId);
      this.books.set(marketId, book);
    }
    return book;
  }

  existingBook(marketId: MarketId): OrderBook | null {
    return this.books.get(marketId) ?? null;
  }

  private remainingOf(marketId: MarketId, orderId: OrderId) {
    return parseIfmQty(this.restingOrders(marketId).find((row) => row.orderId === orderId)?.remaining);
  }

  private beginInFlight(marketId: MarketId, orderId: OrderId, mutation: IfmMutation, at: string): void {
    const remaining = this.remainingOf(marketId, orderId);
    if (remaining === null) return;
    this.journal.append({
      kind: 'in_flight',
      marketId,
      at,
      orderId,
      mutation,
      inFlight: true,
      qty: formatAmount(remaining),
    });
    this.inFlight.set(orderId, { marketId, orderId, mutation, status: 'open', qty: remaining });
  }

  private endInFlight(orderId: OrderId): void {
    this.inFlight.delete(orderId);
  }

  private refuseInFlightSubmit(orderId: OrderId): SubmitResult | null {
    const mark = this.inFlight.get(orderId);
    if (!mark) return null;
    return inFlightSubmitResult(orderId, mark.status === 'unknown');
  }

  private refuseInFlightAmend(orderId: OrderId): AmendResult | null {
    const mark = this.inFlight.get(orderId);
    if (!mark) return null;
    return inFlightAmendResult(orderId, mark.status === 'unknown');
  }

  private refuseInFlightCancel(orderId: OrderId): CancelResult | null {
    const mark = this.inFlight.get(orderId);
    if (!mark) return null;
    return inFlightCancelResult(orderId, mark.status === 'unknown');
  }

  private dropIfNeverTraded(marketId: MarketId): void {
    const book = this.books.get(marketId);
    if (book?.isNeverPrintedEmpty) this.books.delete(marketId);
  }

  hasMarket(marketId: MarketId): boolean {
    return this.books.has(marketId);
  }

  /** Opened by an approved OPEN and still live (not expired, not delisted). */
  isListed(marketId: MarketId): boolean {
    return this.listedMarkets.has(marketId) && !this.expiredMarkets.has(marketId) && !this.delistedMarkets.has(marketId);
  }

  /** Every market with a book, plus every opened market that has none yet. */
  get markets(): readonly MarketId[] {
    const ids = new Set<MarketId>(this.books.keys());
    for (const marketId of this.listedMarkets) {
      if (this.isListed(marketId)) ids.add(marketId);
    }
    return [...ids].sort();
  }

  /** Owner spread listings, sorted by id. Empty when nothing is listed — never a sample instrument. */
  spreadInstruments(): readonly SpreadInstrument[] {
    return [...this.spreads.keys()].sort().map((id) => this.spreads.get(id) as SpreadInstrument);
  }

  spreadInstrument(spreadId: MarketId): SpreadInstrument | null {
    return this.spreads.get(spreadId) ?? null;
  }

  /**
   * The spread book in spread-price units, or null when the spread is not listed. A listed spread with no orders is
   * an empty book, not a refusal. `limit` is required, as for depth.
   */
  spreadBook(spreadId: MarketId, limit?: number | null): SpreadBookView | null {
    const instrument = this.spreads.get(spreadId);
    if (!instrument) return null;
    const n = publishedEngineL2Limit(limit);
    const book = this.existingBook(spreadId);
    const depth = book ? book.depth(n) : { bids: [], asks: [], sequence: 0 };
    const best = (price: Amount | null | undefined): string | null => (price == null ? null : formatAmount(price));
    return {
      instrument,
      bids: depth.bids,
      asks: depth.asks,
      sequence: depth.sequence,
      bestBid: best(book?.bestBid()),
      bestAsk: best(book?.bestAsk()),
      lastPrice: best(book?.lastPrice),
    };
  }

  /**
   * List one owner spread instrument (CB-otc-16). The router consumes the dual-control approval first; this records
   * who approved, journals the listing, and only then makes it tradable. Re-listing the same definition is a no-op;
   * a different definition under a listed id refuses — open orders were admitted under the first one.
   */
  async listSpread(
    input: SpreadListingInput,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<SpreadListResult> {
    const spreadId = typeof input.spreadId === 'string' ? input.spreadId.trim() : '';
    return withEngineSpan('matching.spreadList', { marketId: spreadId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const dual = dualControlRefuse(operatorId, confirmOperatorId);
      if (dual) return spreadListRefused(spreadId, dual);

      const read = readSpreadListing(input);
      if (!read.ok) return spreadListRefused(spreadId, read.rejected);
      const instrument = read.instrument;
      const id = instrument.spreadId;

      const listed = this.spreads.get(id);
      if (listed) {
        if (spreadIdentity(listed) === spreadIdentity(instrument)) {
          return { accepted: true, spreadId: id, instrument: listed, alreadyListed: true };
        }
        return spreadListRefused(id, {
          code: 'spread_listing_conflict',
          message: `${id} is already listed with a different definition; list the change under a new id`,
        });
      }
      if (this.books.has(id) || this.listedMarkets.has(id) || this.prelaunchMarkets.has(id)) {
        return spreadListRefused(id, { code: 'spread_id_collides', message: `${id} is already an outright market` });
      }
      const nested = instrument.legs.find((leg) => this.spreads.has(leg.symbol));
      if (nested) {
        return spreadListRefused(id, { code: 'spread_legs_invalid', message: `leg ${nested.symbol} is itself a spread` });
      }

      this.journal.append({
        kind: 'spread_list',
        marketId: id,
        at: this.clock().toISOString(),
        operatorId: operatorId as string,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
        instrument: toWireSpread(instrument),
      });
      this.spreads.set(id, instrument);
      return { accepted: true, spreadId: id, instrument, alreadyListed: false };
    });
  }

  /**
   * Place a spread order. The engine stamps the listing onto the order, so the journal carries the exact definition
   * the order was admitted under, then runs the normal submit path: every gate, the journal, the book, the events.
   */
  async submitSpread(spreadId: MarketId, input: SpreadOrderInput, lifecycleProof?: MarketLifecycleAdmissionProof): Promise<SubmitResult> {
    const instrument = this.spreads.get(spreadId);
    if (!instrument) {
      return refusedSubmit({ code: 'spread_unlisted', message: `no spread instrument ${spreadId} is listed` });
    }
    const order: EngineOrder = {
      orderId: input.orderId,
      accountId: input.accountId,
      type: 'limit',
      side: input.side,
      qty: input.qty,
      price: input.price,
      stopPrice: null,
      tif: input.tif,
      ...(input.clientOrderId ? { clientOrderId: input.clientOrderId } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      spread: { instrument, anchorReference: input.anchorReference ?? null },
    };
    return this.submit(spreadId, order, lifecycleProof);
  }

  /** Why a submit must not reach the journal for spread reasons, or null. Outright orders on spread ids refuse here. */
  private spreadAdmissionRefuse(marketId: MarketId, order: EngineOrder, book: OrderBook | null, now: Date | null): RejectReason | null {
    const listed = this.spreads.get(marketId);
    if (order.spread == null) return listed || isSpreadBook(book) ? outrightOnSpreadRefuse(marketId) : null;
    if (!listed) return { code: 'spread_unlisted', message: `no spread instrument ${marketId} is listed` };
    if (spreadIdentity(order.spread.instrument) !== spreadIdentity(listed)) {
      return { code: 'spread_identity_disagrees', message: `the order does not carry the ${marketId} listing` };
    }
    if (this.spreadFills === null) {
      return {
        code: 'spread_fill_event_unwired',
        message: 'no spread fill event subject is declared yet; a spread fill nobody announces would strand the maker hold',
      };
    }
    for (const leg of listed.legs) {
      const closed = this.legClosedReason(leg.symbol);
      if (closed) {
        return { code: 'spread_leg_unavailable', message: `leg ${leg.symbol} is ${closed} here; the whole spread refuses` };
      }
    }
    return spreadOrderRefuse(book, marketId, order, now);
  }

  /** A leg market this engine knows is closed. A leg it has never seen (futures today) is not judged here. */
  private legClosedReason(symbol: MarketId): string | null {
    if (this.holdHalted.has(symbol)) return 'held closed';
    if (this.maintenance.has(symbol)) return 'in maintenance';
    if (this.halted.has(symbol)) return 'halted';
    if (this.expiredMarkets.has(symbol)) return 'expired';
    if (this.delistedMarkets.has(symbol)) return 'delisted';
    if (this.prelaunchMarkets.has(symbol)) return 'in prelaunch';
    return null;
  }

  /**
   * Depth for a market that holds a book. An opened market with no book yet (never traded, not delisted or expired)
   * is a live, empty ladder, so its first order can be checked and placed. Any other market is null.
   * `limit` is required. Unset refuses (never invent 50). Owner-explicit 50 is a published window.
   */
  depth(marketId: MarketId, limit?: number | null): ReturnType<OrderBook['depth']> | null {
    const n = publishedEngineL2Limit(limit);
    const book = this.existingBook(marketId);
    if (book) return book.depth(n);
    return this.isListed(marketId) ? { bids: [], asks: [], sequence: 0 } : null;
  }

  restingOrders(marketId?: MarketId): readonly EngineLiveOrder[] {
    const books = marketId === undefined ? [...this.books.values()] : [this.books.get(marketId)].filter((b): b is OrderBook => b != null);

    const live: EngineLiveOrder[] = [];

    for (const book of books) {
      const state = book.toState();

      const takeSide = (levels: readonly PriceLevelState[], side: OrderSide): void => {
        for (const level of levels) {
          for (const order of level.orders) {
            live.push({
              marketId: state.marketId,
              orderId: order.orderId,
              accountId: order.accountId,
              kind: 'book',
              side,
              price: level.price,
              remaining: order.remaining,
              sequence: order.sequence,
              version: order.version && order.version > 0 ? order.version : 1,
            });
          }
        }
      };

      takeSide(state.bids, 'buy');
      takeSide(state.asks, 'sell');

      for (const stop of state.stops) {
        live.push({
          marketId: state.marketId,
          orderId: stop.orderId,
          accountId: stop.accountId,
          kind: 'stop',
          side: stop.side,
          price: stop.stopPrice,
          remaining: stop.qty,
          sequence: stop.sequence,
          version: stop.version && stop.version > 0 ? stop.version : 1,
        });
      }
    }

    return live.sort((a, b) => (a.marketId === b.marketId ? a.sequence - b.sequence : a.marketId < b.marketId ? -1 : 1));
  }

  get restingOrderCount(): number {
    return this.restingOrders().length;
  }

  /**
   * Resting orders for the hold check. Stops carry their limit as `fundingPrice`
   * (null when the stop has no limit). `restingOrders().price` is the trigger
   * for a stop, which is not the notional the hold was sized at.
   */
  restingHoldSubjects(): RestingHoldSubject[] {
    const subjects: RestingHoldSubject[] = [];
    for (const book of this.books.values()) {
      const state = book.toState();
      const takeSide = (levels: readonly PriceLevelState[], side: OrderSide): void => {
        for (const level of levels) {
          for (const order of level.orders) {
            subjects.push({
              marketId: state.marketId,
              orderId: order.orderId,
              accountId: order.accountId,
              side,
              remaining: order.remaining,
              fundingPrice: level.price,
              sequence: order.sequence,
            });
          }
        }
      };
      takeSide(state.bids, 'buy');
      takeSide(state.asks, 'sell');
      for (const stop of state.stops) {
        subjects.push({
          marketId: state.marketId,
          orderId: stop.orderId,
          accountId: stop.accountId,
          side: stop.side,
          remaining: stop.qty,
          fundingPrice: stop.price,
          sequence: stop.sequence,
        });
      }
    }
    return subjects.sort((a, b) => (a.marketId === b.marketId ? a.sequence - b.sequence : a.marketId < b.marketId ? -1 : 1));
  }

  get admissionOpen(): boolean {
    return this.admissionClosed === null;
  }

  get admissionReason(): string | null {
    return this.admissionClosed;
  }

  holdHaltedMarkets(): readonly MarketId[] {
    return [...this.holdHalted.keys()].sort();
  }

  holdHaltReason(marketId: MarketId): string | null {
    return this.holdHalted.get(marketId) ?? null;
  }

  /** Fail closed for the whole book. Not journalled — the next boot asks again. */
  closeAdmission(reason: string): void {
    this.admissionClosed = reason;
  }

  /** One market stays halted because a resting hold could not be pulled. Not an operator halt. */
  holdHalt(marketId: MarketId, reason: string): void {
    this.holdHalted.set(marketId, reason);
  }

  /** Live publishes after this do not take the startup backoff. */
  finishStartupAnnounce(): void {
    this.announcing = false;
  }

  /** Open STP cases across live books. Evidence only — not a sanction. */
  openSurveillanceCases(): readonly EngineSurveillanceCase[] {
    const opened: EngineSurveillanceCase[] = [];
    for (const marketId of this.markets) {
      const book = this.books.get(marketId);
      if (book) opened.push(...book.openSurveillanceCases());
    }
    return opened;
  }

  snapshot(): EngineSnapshot {
    return snapshotAll(this.books, this.journal.length, this.deadSessions);
  }

  serialize(): string {
    return serializeBooks(this.books);
  }

  async submit(marketId: MarketId, order: EngineOrder, lifecycleProof?: MarketLifecycleAdmissionProof): Promise<SubmitResult> {
    return withEngineSpan(
      'matching.submit',
      { marketId, orderId: order.orderId, side: order.side, orderType: order.type, tif: order.tif },
      async (): Promise<SubmitResult & { fillCount: number; rejectCode?: string }> => {
        if (!this.enabled) {
          const result = disabled(order.orderId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        if (this.admissionClosed) {
          const result = holdCheckClosedResult(order.orderId, this.admissionClosed);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        if (this.holdHalted.has(marketId)) {
          const result = holdUnconfirmedResult(marketId, order.orderId, this.holdHalted.get(marketId) ?? 'matching.hold_unconfirmed');
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        if (this.venueHalted) {
          const result = venueHaltedSubmitResult(order.orderId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        if (this.maintenance.has(marketId)) {
          const result = maintenanceSubmitResult(marketId, order.orderId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        if (this.halted.has(marketId)) {
          const result = haltedSubmitResult(marketId, order.orderId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        if (this.expiredMarkets.has(marketId)) {
          const result = expiredSubmitResult(marketId, order.orderId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        if (this.delistedMarkets.has(marketId)) {
          const result = delistedSubmitResult(marketId, order.orderId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        if (this.prelaunchMarkets.has(marketId)) {
          const result = prelaunchSubmitResult(marketId, order.orderId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        if (this.reduceOnlyMarkets.has(marketId) && wouldOpenOrIncrease(this.existingBook(marketId), order)) {
          const result = reduceOnlyMarketSubmitResult(marketId, order.orderId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        if (this.postOnlyMarkets.has(marketId) && !isPostOnlySubmit(order)) {
          const result = postOnlyMarketSubmitResult(marketId, order.orderId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        const sessionId = readSessionId(order);
        if (sessionId !== null && this.deadSessions.has(sessionId)) {
          const result = sessionGoneSubmitResult(order.orderId, sessionId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        const inFlightSubmit = this.refuseInFlightSubmit(order.orderId);
        if (inFlightSubmit) return { ...inFlightSubmit, fillCount: 0, rejectCode: inFlightSubmit.rejected?.code };

        const existing = this.existingBook(marketId);
        if (existing?.hasAccepted(order.orderId)) {
          const duplicate = existing.submit(order, this.expiryClock ? this.expiryClock() : null);
          return { ...duplicate, fillCount: 0, rejectCode: duplicate.rejected?.code };
        }

        // One instant for the journal and the expiry check. A second read can
        // reject already_expired while `at` is still early enough for replay to match.
        const expiryNow = this.expiryClock ? this.expiryClock() : null;
        // Spread admission (CB-otc-16) refuses before the journal: a refused spread leaves no record and no leg.
        const spreadRefusal = this.spreadAdmissionRefuse(marketId, order, existing, expiryNow);
        if (spreadRefusal) {
          const result = refusedSubmit(spreadRefusal);
          return { ...result, fillCount: 0, rejectCode: spreadRefusal.code };
        }
        if ((order.tif === 'GTD' || order.tif === 'GTT') && expiryNow == null) {
          const result = clockMissing(order.orderId);
          return { ...result, fillCount: 0, rejectCode: result.rejected?.code };
        }
        const at = (expiryNow ?? this.clock()).toISOString();
        this.journal.append({ kind: 'submit', marketId, at, order: toWire(order, lifecycleProof) });

        const result = this.book(marketId).submit(order, expiryNow);
        this.dropIfNeverTraded(marketId);
        await this.emit(this.eventsForSubmit(marketId, order.orderId, result, at));
        await this.maybeSnapshot();

        return { ...result, fillCount: result.fills.length, rejectCode: result.rejected?.code };
      },
    );
  }

  async cancel(marketId: MarketId, orderId: OrderId, reason: CancelReason = 'requested'): Promise<CancelResult> {
    return withEngineSpan('matching.cancel', { marketId, orderId }, async (): Promise<CancelResult & { fillCount: number }> => {
      if (this.maintenance.has(marketId)) {
        return {
          cancelled: false,
          orderId,
          sequence: null,
          cancellation: null,
          rejected: maintenanceRefuse(marketId),
          fillCount: 0,
        };
      }
      const inFlightCancel = this.refuseInFlightCancel(orderId);
      if (inFlightCancel) return { ...inFlightCancel, fillCount: 0 };

      const existing = this.existingBook(marketId);
      if (!existing) {
        return { cancelled: false, orderId, sequence: null, cancellation: null, fillCount: 0 };
      }

      const at = this.clock().toISOString();
      this.beginInFlight(marketId, orderId, 'cancel', at);
      this.journal.append({
        kind: 'cancel',
        marketId,
        at,
        orderId,
        ...(reason !== 'requested' ? { reason } : {}),
      });

      const result = existing.cancel(orderId, reason);
      this.endInFlight(orderId);
      if (result.cancellation) await this.emit([cancelledEvent(marketId, result.cancellation)]);
      await this.maybeSnapshot();

      return { ...result, fillCount: 0 };
    });
  }

  async massCancel(
    marketId: MarketId,
    cmd: { readonly accountId: string; readonly sessionId?: string | null; readonly side?: OrderSide | null },
  ): Promise<MassCancelResult> {
    return withEngineSpan('matching.massCancel', { marketId }, async (): Promise<MassCancelResult & { fillCount: number }> => {
      if (this.maintenance.has(marketId)) {
        return {
          accepted: false,
          accountId: cmd.accountId,
          cancellations: [],
          rejected: maintenanceRefuse(marketId),
          fillCount: 0,
        };
      }
      const sessionRefuse = massCancelSessionRefuse(readSessionId(cmd));
      if (sessionRefuse) {
        return {
          accepted: false,
          accountId: cmd.accountId,
          cancellations: [],
          rejected: { code: sessionRefuse.code, message: sessionRefuse.message },
          fillCount: 0,
        };
      }

      const existing = this.existingBook(marketId);
      if (!existing) {
        return { accepted: true, accountId: cmd.accountId, cancellations: [], fillCount: 0 };
      }

      const side = readMassCancelSide(cmd);
      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'mass_cancel',
        marketId,
        at,
        accountId: cmd.accountId,
        ...(side ? { side } : {}),
      });

      const cancellations = existing.cancelAccount(cmd.accountId, side);
      this.dropIfNeverTraded(marketId);
      if (cancellations.length > 0) {
        await this.emit(cancellations.map((cancellation) => cancelledEvent(marketId, cancellation)));
      }
      await this.maybeSnapshot();

      return { accepted: true, accountId: cmd.accountId, cancellations, fillCount: 0 };
    });
  }

  async sessionDead(cmd: { readonly sessionId?: string | null }): Promise<SessionDeadResult> {
    return withSpan('matching.session_dead', async (): Promise<SessionDeadResult & { fillCount: number }> => {
      const sessionId = readSessionId(cmd);
      if (sessionId === null) {
        return {
          accepted: false,
          sessionId: null,
          cancellations: [],
          rejected: missingSessionRefuse(),
          fillCount: 0,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({ kind: 'session_dead', at, sessionId });
      this.deadSessions.add(sessionId);

      const cancellations: CancelledRef[] = [];
      const events: PendingEvent[] = [];
      for (const marketId of [...this.books.keys()].sort()) {
        const book = this.books.get(marketId);
        if (!book || this.maintenance.has(marketId)) continue;
        const pulled = book.cancelSession(sessionId);
        for (const cancellation of pulled) {
          cancellations.push(cancellation);
          events.push(cancelledEvent(marketId, cancellation));
        }
        this.dropIfNeverTraded(marketId);
      }
      if (events.length > 0) await this.emit(events);
      await this.maybeSnapshot();

      return { accepted: true, sessionId, cancellations, fillCount: 0 };
    });
  }

  /**
   * Refusal before the journal and the book. Null when the book would take the command.
   * Omit `book` to read the live book. Pass a copy to preview an atomic group.
   */
  amendRefusal(marketId: MarketId, cmd: EngineAmend, book?: OrderBook | null): AmendResult | null {
    if (!this.enabled) return disabledAmend(cmd.orderId);
    if (this.spreads.has(marketId) || isSpreadBook(book === undefined ? this.existingBook(marketId) : book)) {
      return {
        ...disabledAmend(cmd.orderId),
        rejected: {
          code: 'spread_amend_unsupported',
          message: 'a spread order does not amend in place; cancel it and place a new one',
        },
      };
    }
    if (this.admissionClosed) return holdCheckClosedAmend(cmd.orderId, this.admissionClosed);
    if (this.holdHalted.has(marketId)) {
      return holdUnconfirmedAmend(marketId, cmd.orderId, this.holdHalted.get(marketId) ?? 'matching.hold_unconfirmed');
    }
    if (this.venueHalted) return venueHaltedAmendResult(cmd.orderId);
    if (this.maintenance.has(marketId)) return maintenanceAmendResult(marketId, cmd.orderId);
    if (this.halted.has(marketId)) return haltedAmendResult(marketId, cmd.orderId);
    if (this.expiredMarkets.has(marketId)) return expiredAmendResult(marketId, cmd.orderId);
    if (this.delistedMarkets.has(marketId)) return delistedAmendResult(marketId, cmd.orderId);
    if (this.prelaunchMarkets.has(marketId)) return prelaunchAmendResult(marketId, cmd.orderId);
    if (this.reduceOnlyMarkets.has(marketId)) {
      const positionBook = book === undefined ? this.existingBook(marketId) : book;
      const live = positionBook ? restingIdentity(positionBook, cmd.orderId) : null;
      // A price or tif amend omits qty and the book re-executes the resting size.
      const qty = cmd.qty ?? live?.qty;
      if (
        live &&
        qty !== undefined &&
        wouldOpenOrIncrease(positionBook, { orderId: cmd.orderId, accountId: live.accountId, side: live.side, qty })
      ) {
        return reduceOnlyMarketAmendResult(marketId, cmd.orderId);
      }
    }
    if (this.postOnlyMarkets.has(marketId)) {
      const seen = book === undefined ? this.existingBook(marketId) : book;
      const postOnlyRefuse = postOnlyAmendRefusal(seen, marketId, cmd);
      if (postOnlyRefuse) return postOnlyRefuse;
    }
    const inFlightAmend = this.refuseInFlightAmend(cmd.orderId);
    if (inFlightAmend) return inFlightAmend;
    const existing = book === undefined ? this.existingBook(marketId) : book;
    if (!existing) {
      return {
        accepted: false,
        orderId: cmd.orderId,
        sequence: null,
        version: null,
        priority: null,
        fills: [],
        resting: null,
        rejected: { code: 'order_not_found', message: `order ${cmd.orderId} is not live in ${marketId}` },
        cancellations: [],
        triggered: [],
      };
    }
    return null;
  }

  async amend(marketId: MarketId, cmd: EngineAmend, lifecycleProof?: MarketLifecycleAdmissionProof): Promise<AmendResult> {
    return withEngineSpan(
      'matching.amend',
      { marketId, orderId: cmd.orderId, tif: cmd.tif },
      async (): Promise<AmendResult & { fillCount: number; rejectCode?: string }> => {
        const blocked = this.amendRefusal(marketId, cmd);
        if (blocked) return { ...blocked, fillCount: 0, rejectCode: blocked.rejected?.code };
        const unsupported = unsupportedAmendField(cmd);
        if (unsupported) {
          return { ...disabledAmend(cmd.orderId), rejected: unsupported, fillCount: 0, rejectCode: unsupported.code };
        }

        const existing = this.existingBook(marketId);
        if (!existing) {
          return {
            accepted: false,
            orderId: cmd.orderId,
            sequence: null,
            version: null,
            priority: null,
            fills: [],
            resting: null,
            rejected: { code: 'order_not_found', message: `order ${cmd.orderId} is not live in ${marketId}` },
            cancellations: [],
            triggered: [],
            fillCount: 0,
            rejectCode: 'order_not_found',
          };
        }

        // One instant for the journal and the expiry sweep. A second read can
        // cancel on one clock and journal an earlier `at` that replay would not match.
        const expiryNow = this.expiryClock ? this.expiryClock() : null;
        const at = (expiryNow ?? this.clock()).toISOString();
        this.beginInFlight(marketId, cmd.orderId, 'amend', at);
        this.journal.append({
          kind: 'amend',
          marketId,
          at,
          orderId: cmd.orderId,
          expectedVersion: cmd.expectedVersion,
          patch: toWireAmend(cmd),
          lifecycleProof,
        });

        const result = existing.amend(cmd, expiryNow);
        this.endInFlight(cmd.orderId);
        this.dropIfNeverTraded(marketId);
        await this.emit(this.eventsForAmend(marketId, result, at));
        await this.maybeSnapshot();

        return { ...result, fillCount: result.fills.length, rejectCode: result.rejected?.code };
      },
    );
  }

  /**
   * Control states that stop a mark from moving a stop. Same gates as an amend, minus the ones about a single
   * order: a mark only tightens a trigger, so reduce-only, post-only and an order in flight do not block it.
   */
  private markRefusal(marketId: MarketId): { readonly code: string; readonly message: string } | null {
    const id = 'trailing-mark';
    if (!this.enabled) return disabledAmend(id).rejected ?? null;
    if (this.admissionClosed) return holdCheckClosedAmend(id, this.admissionClosed).rejected ?? null;
    if (this.holdHalted.has(marketId)) {
      return holdUnconfirmedAmend(marketId, id, this.holdHalted.get(marketId) ?? 'matching.hold_unconfirmed').rejected ?? null;
    }
    if (this.venueHalted) return venueHaltedAmendResult(id).rejected ?? null;
    if (this.maintenance.has(marketId)) return maintenanceAmendResult(marketId, id).rejected ?? null;
    if (this.halted.has(marketId)) return haltedAmendResult(marketId, id).rejected ?? null;
    if (this.expiredMarkets.has(marketId)) return expiredAmendResult(marketId, id).rejected ?? null;
    if (this.delistedMarkets.has(marketId)) return delistedAmendResult(marketId, id).rejected ?? null;
    if (this.prelaunchMarkets.has(marketId)) return prelaunchAmendResult(marketId, id).rejected ?? null;
    return null;
  }

  /**
   * Walk the live trailing stops of one market with a server-side mark. A blank or non-positive mark is refused,
   * never replaced. The peak only ratchets and the trigger only tightens, so a repeated or older mark changes
   * nothing and needs no sequence. A mark that moved something is journaled in the same step it is applied, so
   * replay reproduces the trigger; a mark that moved nothing writes nothing.
   */
  markTrailingStops(marketId: MarketId, mark: string): MarkResult {
    const parsedMark = /^\d+(\.\d{1,18})?$/.test(mark) ? parseAmount(mark) : null;
    const missing = markRefuse(parsedMark);
    if (missing) return { accepted: false, applied: false, rejected: missing };
    const blocked = this.markRefusal(marketId);
    if (blocked) return { accepted: false, applied: false, rejected: blocked };
    const book = this.existingBook(marketId);
    if (!book) return { accepted: true, applied: false, rejected: null };
    const walked = walkTrailingStops(book, parsedMark);
    if (walked.refused) return { accepted: false, applied: false, rejected: walked.refused };
    if (walked.changed) this.journal.append({ kind: 'mark', marketId, at: this.clock().toISOString(), mark });
    return { accepted: true, applied: walked.changed, rejected: null };
  }

  async closePosition(
    marketId: MarketId,
    cmd: ClosePositionCommand,
    lifecycleProof?: MarketLifecycleAdmissionProof,
  ): Promise<SubmitResult> {
    if (!this.enabled) {
      return disabled(cmd.orderId);
    }

    const existing = this.existingBook(marketId);
    if (!existing) return positionFlatResult();
    const net = netPositionOf(existing, cmd.accountId);
    if (net === ZERO) return positionFlatResult();

    return this.submit(marketId, flattenCloseOrder(cmd, net), lifecycleProof);
  }

  async halt(marketId: MarketId, cmd: EmergencyCmd): Promise<MarketHaltResult> {
    return withEngineSpan('matching.halt', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          halted: this.halted.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'halt',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      if (!this.halted.has(marketId)) this.haltedSince.set(marketId, at);
      this.halted.add(marketId);
      return { accepted: true, marketId, halted: true, operatorId, confirmOperatorId };
    });
  }

  async resume(marketId: MarketId, cmd: EmergencyCmd): Promise<MarketHaltResult> {
    return withEngineSpan('matching.resume', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          halted: this.halted.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'resume',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.halted.delete(marketId);
      this.haltedSince.delete(marketId);
      return { accepted: true, marketId, halted: false, operatorId, confirmOperatorId };
    });
  }

  async haltAll(cmd: EmergencyCmd): Promise<VenueKillResult> {
    return withSpan('matching.halt_all', async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      if (operatorId === null) {
        return {
          accepted: false,
          halted: this.venueHalted,
          operatorId: null,
          confirmOperatorId,
          rejected: operatorRefuse(null)!,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'halt_all',
        at,
        operatorId,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      if (!this.venueHalted) this.venueHaltedAt = at;
      this.venueHalted = true;
      return { accepted: true, halted: true, operatorId, confirmOperatorId };
    });
  }

  async resumeAll(cmd: EmergencyCmd): Promise<VenueKillResult> {
    return withSpan('matching.resume_all', async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      if (operatorId === null) {
        return {
          accepted: false,
          halted: this.venueHalted,
          operatorId: null,
          confirmOperatorId,
          rejected: operatorRefuse(null)!,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'resume_all',
        at,
        operatorId,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.venueHalted = false;
      this.venueHaltedAt = null;
      return { accepted: true, halted: false, operatorId, confirmOperatorId };
    });
  }

  async reduceOnly(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketReduceOnlyResult> {
    return withEngineSpan('matching.reduce_only', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          reduceOnly: this.reduceOnlyMarkets.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'reduce_only',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.reduceOnlyMarkets.add(marketId);
      return { accepted: true, marketId, reduceOnly: true, operatorId, confirmOperatorId };
    });
  }

  async resumeReduceOnly(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketReduceOnlyResult> {
    return withEngineSpan('matching.resume_reduce_only', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          reduceOnly: this.reduceOnlyMarkets.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'resume_reduce_only',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.reduceOnlyMarkets.delete(marketId);
      return { accepted: true, marketId, reduceOnly: false, operatorId, confirmOperatorId };
    });
  }

  async postOnly(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketPostOnlyResult> {
    return withEngineSpan('matching.post_only', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          postOnly: this.postOnlyMarkets.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'post_only',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.postOnlyMarkets.add(marketId);
      return { accepted: true, marketId, postOnly: true, operatorId, confirmOperatorId };
    });
  }

  async resumePostOnly(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketPostOnlyResult> {
    return withEngineSpan('matching.resume_post_only', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          postOnly: this.postOnlyMarkets.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'resume_post_only',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.postOnlyMarkets.delete(marketId);
      return { accepted: true, marketId, postOnly: false, operatorId, confirmOperatorId };
    });
  }

  async prelaunch(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketPrelaunchResult> {
    return withEngineSpan('matching.prelaunch', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          prelaunch: this.prelaunchMarkets.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'prelaunch',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.prelaunchMarkets.add(marketId);
      return { accepted: true, marketId, prelaunch: true, operatorId, confirmOperatorId };
    });
  }

  async open(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketPrelaunchResult> {
    return withEngineSpan('matching.open', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          prelaunch: this.prelaunchMarkets.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'open',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.prelaunchMarkets.delete(marketId);
      this.listedMarkets.add(marketId);
      return { accepted: true, marketId, prelaunch: false, operatorId, confirmOperatorId };
    });
  }

  async expire(marketId: MarketId, cmd: EmergencyCmd): Promise<MarketExpireResult> {
    return withEngineSpan('matching.expire', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          expired: this.expiredMarkets.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'expire',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.expiredMarkets.add(marketId);
      return { accepted: true, marketId, expired: true, operatorId, confirmOperatorId };
    });
  }

  async delist(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketDelistResult> {
    return withEngineSpan('matching.delist', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          delisted: this.delistedMarkets.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }

      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'delist',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.delistedMarkets.add(marketId);
      return { accepted: true, marketId, delisted: true, operatorId, confirmOperatorId };
    });
  }

  async enterMaintenance(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketMaintenanceResult> {
    return withEngineSpan('matching.maintenance', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          maintenance: this.maintenance.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }
      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'maintenance',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.maintenance.add(marketId);
      return { accepted: true, marketId, maintenance: true, operatorId, confirmOperatorId };
    });
  }

  async endMaintenance(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketMaintenanceResult> {
    return withEngineSpan('matching.end_maintenance', { marketId }, async () => {
      const operatorId = readOperatorId(cmd);
      const confirmOperatorId = readConfirmOperatorId(cmd);
      const refuse = dualControlRefuse(operatorId, confirmOperatorId);
      if (refuse) {
        return {
          accepted: false,
          marketId,
          maintenance: this.maintenance.has(marketId),
          operatorId,
          confirmOperatorId,
          rejected: refuse,
        };
      }
      const at = this.clock().toISOString();
      this.journal.append({
        kind: 'end_maintenance',
        marketId,
        at,
        operatorId: operatorId!,
        ...(confirmOperatorId ? { confirmOperatorId } : {}),
      });
      this.maintenance.delete(marketId);
      return { accepted: true, marketId, maintenance: false, operatorId, confirmOperatorId };
    });
  }

  /**
   * Cancel GTD/GTT rests that are already due, even when no later order arrives.
   * A book that cannot be read is left in place and named on the miss.
   */
  async sweepExpiry(): Promise<ExpirySweepResult> {
    if (this.expiryClock === null) {
      return {
        accepted: false,
        cancelled: [],
        misses: [],
        rejected: {
          code: 'engine_clock_missing',
          message: 'GTD/GTT expires on the engine clock; refuse when that clock is missing',
        },
      };
    }
    const now = this.expiryClock();
    const cancelled: CancelledRef[] = [];
    const misses: ExpirySweepResult['misses'][number][] = [];
    for (const marketId of [...this.books.keys()].sort()) {
      const unread = this.unreadableBooks.get(marketId);
      if (unread !== undefined) {
        misses.push({ marketId, code: 'book_unreadable', reason: unread });
        continue;
      }
      const book = this.books.get(marketId);
      if (!book) {
        misses.push({ marketId, code: 'book_unreadable', reason: 'book missing' });
        continue;
      }
      let due: string[] = [];
      try {
        due = book.dueExpiry(now);
      } catch {
        misses.push({ marketId, code: 'book_unreadable', reason: 'book unreadable' });
        continue;
      }
      for (const orderId of due) {
        const result = await this.cancel(marketId, orderId, 'expired');
        if (result.cancellation) cancelled.push(result.cancellation);
      }
    }
    return { accepted: true, cancelled, misses };
  }

  private eventsForSubmit(marketId: MarketId, orderId: OrderId, result: SubmitResult, at: string): PendingEvent[] {
    const events: PendingEvent[] = [];

    if (result.accepted && result.sequence !== null) {
      events.push({
        sequence: result.sequence,
        name: 'orderAccepted',
        payload: { orderId, marketId, sequence: result.sequence },
        key: `matching.order.accepted:${marketId}:${orderId}`,
      });
    }

    const collect = (fills: readonly Fill[], cancellations: readonly CancelledRef[]): void => {
      for (const fill of fills) events.push(fillEvent(marketId, fill, at));
      for (const cancellation of cancellations) events.push(cancelledEvent(marketId, cancellation));
    };

    collect(result.fills, result.cancellations);
    for (const triggered of result.triggered as readonly TriggerOutcome[]) {
      if (triggered.trigger) events.push(triggeredEvent(marketId, triggered.orderId, triggered.sequence, triggered.trigger, at));
      collect(triggered.fills, triggered.cancellations);
    }

    return events.sort((a, b) => a.sequence - b.sequence);
  }

  private eventsForAmend(marketId: MarketId, result: AmendResult, at: string): PendingEvent[] {
    const events: PendingEvent[] = [];
    for (const cancellation of result.cancellations) events.push(cancelledEvent(marketId, cancellation));
    for (const fill of result.fills) events.push(fillEvent(marketId, fill, at));
    for (const triggered of result.triggered as readonly TriggerOutcome[]) {
      if (triggered.trigger) events.push(triggeredEvent(marketId, triggered.orderId, triggered.sequence, triggered.trigger, at));
      for (const fill of triggered.fills) events.push(fillEvent(marketId, fill, at));
      for (const cancellation of triggered.cancellations) events.push(cancelledEvent(marketId, cancellation));
    }
    // An amend that fires its own stop reports that stop's fills and cancels on the result and on its trigger outcome.
    const once = events.filter((event, index) => events.findIndex((other) => other.key === event.key) === index);
    return once.sort((a, b) => a.sequence - b.sequence);
  }

  private async emit(events: readonly PendingEvent[]): Promise<void> {
    for (const event of events) {
      const opts = { idempotencyKey: event.key };
      const send = () => this.publishNamed(event, opts);
      if (this.announcing) await publishWithStartupRetry(send, this.startupSleep);
      else await send();
    }
  }

  private publishNamed(event: PendingEvent, opts: { readonly idempotencyKey: string }): Promise<unknown> {
    switch (event.name) {
      case 'orderAccepted':
        return this.bus.publish('orderAccepted', event.payload, opts);
      case 'orderFilled':
        return this.bus.publish('orderFilled', event.payload, opts);
      case 'orderCancelled':
        return this.bus.publish('orderCancelled', event.payload, opts);
      case 'orderTriggered':
        return this.bus.publish('orderTriggered', event.payload, opts);
      case 'spreadFilled':
        // Admission refuses spreads without a publisher, so only a journal written by a build that had one reaches
        // here. Fail the boot rather than drop a maker's fill.
        if (this.spreadFills === null) {
          return Promise.reject(new Error(`spread fill ${event.key} has no publisher; refusing to drop it`));
        }
        return Promise.resolve(this.spreadFills.publish(event.payload, opts));
    }
  }

  private async maybeSnapshot(): Promise<void> {
    if (this.snapshotEvery <= 0) return;
    if (this.journal.length % this.snapshotEvery !== 0) return;
    await this.sink.write(this.snapshot());
  }
}

/** A spread book read: L2 in spread-price units plus the top of book and the last spread print. */
export interface SpreadBookView {
  readonly instrument: SpreadInstrument;
  readonly bids: Array<[string, string]>;
  readonly asks: Array<[string, string]>;
  readonly sequence: number;
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
  readonly lastPrice: string | null;
}

export interface SpreadListResult {
  readonly accepted: boolean;
  readonly spreadId: string;
  readonly instrument: SpreadInstrument | null;
  readonly alreadyListed: boolean;
  readonly rejected?: { readonly code: string; readonly message: string };
}

/** Decimal-free: amounts arrive parsed. The engine stamps the listing; the caller never sends it. */
export interface SpreadOrderInput {
  readonly orderId: OrderId;
  readonly accountId: string;
  readonly side: OrderSide;
  readonly qty: Amount;
  readonly price: Amount;
  readonly tif: EngineOrder['tif'];
  readonly anchorReference: Amount | null;
  readonly clientOrderId?: string | null;
  readonly environment?: string | null;
  readonly sessionId?: string | null;
}

function spreadListRefused(spreadId: string, rejected: { readonly code: string; readonly message: string }): SpreadListResult {
  return { accepted: false, spreadId, instrument: null, alreadyListed: false, rejected };
}

/** A spread fill carries its legs and announces as one spread fill; an outright fill is `orderFilled`. */
function fillEvent(marketId: MarketId, fill: Fill, at: string): PendingEvent {
  if (fill.legs !== undefined) {
    return {
      sequence: fill.sequence,
      name: 'spreadFilled',
      payload: spreadFillEvent(marketId, fill, at),
      key: spreadFillKey(marketId, fill.sequence),
    };
  }
  return filledEvent(marketId, fill, at);
}

function filledEvent(marketId: MarketId, fill: Fill, at: string): PendingEvent {
  return {
    sequence: fill.sequence,
    name: 'orderFilled',
    payload: {
      marketId,
      makerOrderId: fill.makerOrderId,
      takerOrderId: fill.takerOrderId,
      price: formatAmount(fill.price),
      qty: formatAmount(fill.qty),
      sequence: fill.sequence,
      ts: at,
      makerAccountId: fill.makerAccountId,
      takerAccountId: fill.takerAccountId,
    },
    key: `matching.order.filled:${marketId}:${fill.sequence}`,
  };
}

function cancelledEvent(marketId: MarketId, cancellation: CancelledRef): PendingEvent {
  return {
    sequence: cancellation.sequence,
    name: 'orderCancelled',
    payload: {
      orderId: cancellation.orderId,
      marketId,
      remainingQty: formatAmount(cancellation.remainingQty),
      sequence: cancellation.sequence,
      // Why it left, so a consumer that hears the event before the inline outcome ends the order the same way.
      reason: cancellation.reason,
    },
    key: `matching.order.cancelled:${marketId}:${cancellation.sequence}`,
  };
}

/** A stop fired: which price it watched, its stop price and the price that reached it. Its fills and cancels follow. */
function triggeredEvent(marketId: MarketId, orderId: OrderId, sequence: number, trigger: TriggerFact, at: string): PendingEvent {
  return {
    sequence,
    name: 'orderTriggered',
    payload: {
      orderId,
      marketId,
      sequence,
      triggerBy: trigger.by,
      stopPrice: formatAmount(trigger.stopPrice),
      referencePrice: formatAmount(trigger.reference),
      ts: at,
    },
    key: `matching.order.triggered:${marketId}:${sequence}`,
  };
}

/** Unset snapshot cadence refuses. Never invent 500. Owner-explicit 0 disables. */
function publishedSnapshotEvery(value: number | undefined | null): number {
  if (value === undefined || value === null) {
    throw new Error('MatchingEngine snapshotEvery is unset — refuse to invent 500');
  }
  return value;
}

function holdCheckClosedResult(orderId: OrderId, reason: string): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: {
      code: 'hold_check_unreachable',
      message: `hold check did not answer (${reason}); market stays closed — order ${orderId} not processed`,
    },
    cancellations: [],
    triggered: [],
  };
}

function holdUnconfirmedResult(marketId: MarketId, orderId: OrderId, reason: string): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: {
      code: 'hold_unconfirmed',
      message: `market ${marketId} stays halted (${reason}) — order ${orderId} not processed`,
    },
    cancellations: [],
    triggered: [],
  };
}

function holdCheckClosedAmend(orderId: OrderId, reason: string): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: {
      code: 'hold_check_unreachable',
      message: `hold check did not answer (${reason}); market stays closed — order ${orderId} not processed`,
    },
    cancellations: [],
    triggered: [],
  };
}

function holdUnconfirmedAmend(marketId: MarketId, orderId: OrderId, reason: string): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: {
      code: 'hold_unconfirmed',
      message: `market ${marketId} stays halted (${reason}) — order ${orderId} not processed`,
    },
    cancellations: [],
    triggered: [],
  };
}

function refusedSubmit(reason: RejectReason): SubmitResult {
  return { accepted: false, sequence: null, fills: [], resting: null, rejected: reason, cancellations: [], triggered: [] };
}

function disabled(orderId: OrderId): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code: 'engine_disabled', message: `matching engine is disabled — order ${orderId} not processed` },
    cancellations: [],
    triggered: [],
  };
}

function clockMissing(orderId: OrderId): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: {
      code: 'engine_clock_missing',
      message: `GTD/GTT expires on the engine clock; refuse when that clock is missing — order ${orderId} not journalled`,
    },
    cancellations: [],
    triggered: [],
  };
}

function restingIdentity(book: OrderBook, orderId: OrderId): { accountId: string; side: OrderSide; qty: Amount } | null {
  const state = book.toState();
  for (const level of state.bids) {
    const row = level.orders.find((order) => order.orderId === orderId);
    if (row) return { accountId: row.accountId, side: 'buy', qty: parseAmount(row.remaining) };
  }
  for (const level of state.asks) {
    const row = level.orders.find((order) => order.orderId === orderId);
    if (row) return { accountId: row.accountId, side: 'sell', qty: parseAmount(row.remaining) };
  }
  const stop = state.stops.find((row) => row.orderId === orderId);
  if (stop) return { accountId: stop.accountId, side: stop.side, qty: parseAmount(stop.qty) };
  return null;
}

function disabledAmend(orderId: OrderId): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: { code: 'engine_disabled', message: `matching engine is disabled — order ${orderId} not processed` },
    cancellations: [],
    triggered: [],
  };
}
