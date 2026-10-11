import { ZERO, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { MarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import type { EventBus, PayloadOf } from '@intafaced/events';
import { publishedEngineL2Limit } from '../l2-limit.js';
import { withEngineSpan, withSpan } from '../tracing.js';
import { OrderBook } from './book.js';
import './trailing-stop.js';
import './option.js';
import { flattenCloseOrder, netPositionOf, positionFlatResult, type ClosePositionCommand } from './close-position.js';
import {
  dualControlRefuse,
  haltedAmendResult,
  haltedSubmitResult,
  operatorRefuse,
  readConfirmOperatorId,
  readOperatorId,
  replayHaltedMarkets,
} from './halt.js';
import { replayVenueHalted, venueHaltedAmendResult, venueHaltedSubmitResult } from './venue-kill.js';
import {
  reduceOnlyMarketAmendResult,
  reduceOnlyMarketSubmitResult,
  replayReduceOnlyMarkets,
  wouldOpenOrIncrease,
} from './reduce-only-market.js';
import { isPostOnlySubmit, postOnlyAmendRefusal, postOnlyMarketSubmitResult, replayPostOnlyMarkets } from './post-only-market.js';
import { prelaunchAmendResult, prelaunchSubmitResult, replayPrelaunchMarkets } from './prelaunch.js';
import {
  delistedAmendResult,
  delistedSubmitResult,
  expiredAmendResult,
  expiredSubmitResult,
  replayDelistedMarkets,
  replayExpiredMarkets,
} from './expire.js';
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
  CancelResult,
  CancelledRef,
  EngineAmend,
  EngineLiveOrder,
  EngineOrder,
  EngineSurveillanceCase,
  Fill,
  MarketHaltResult,
  MarketId,
  MarketPostOnlyResult,
  MarketDelistResult,
  MarketExpireResult,
  MarketPrelaunchResult,
  MarketReduceOnlyResult,
  MassCancelResult,
  SessionDeadResult,
  VenueKillResult,
  OrderId,
  OrderSide,
  PriceLevelState,
  SubmitResult,
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
}

type PendingEvent =
  | { readonly sequence: number; readonly name: 'orderAccepted'; readonly payload: PayloadOf<'orderAccepted'>; readonly key: string }
  | { readonly sequence: number; readonly name: 'orderFilled'; readonly payload: PayloadOf<'orderFilled'>; readonly key: string }
  | { readonly sequence: number; readonly name: 'orderCancelled'; readonly payload: PayloadOf<'orderCancelled'>; readonly key: string };

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
  /** Operator halt of every market. Distinct from one-market halt. No duration. */
  private venueHalted = false;
  /** One-market operator reduce-only. Not halt. No duration. */
  private readonly reduceOnlyMarkets = new Set<MarketId>();
  /** One-market operator post-only. Not halt. No duration. */
  private readonly postOnlyMarkets = new Set<MarketId>();
  /** One-market operator prelaunch. Public submits refuse until OPEN. Not halt. No duration. */
  private readonly prelaunchMarkets = new Set<MarketId>();
  /** One-market operator expire. New submits refuse. Cancels stay. Not halt. No notice period. */
  private readonly expiredMarkets = new Set<MarketId>();
  /** One-market operator delist. New submits refuse. Cancels stay. Not halt. No notice period. */
  private readonly delistedMarkets = new Set<MarketId>();
  /** Dead sessions. Tagged submits refuse. Tagged rests cancel on session-dead. Not mass-cancel. */
  private readonly deadSessions = new Set<string>();
  /** Unconfirmed amend/cancel. Second live rest or duplicate fill for that id refuses. */
  private readonly inFlight = new Map<OrderId, InFlightMark>();

  constructor(options: MatchingEngineOptions) {
    this.journal = options.journal;
    this.bus = options.bus;
    this.clock = options.clock ?? (() => new Date());
    this.expiryClock = options.clock ?? null;
    this.snapshotEvery = publishedSnapshotEvery(options.snapshotEvery);
    this.sink = options.snapshotSink ?? new MemorySnapshotSink();
    this.enabled = options.enabled ?? true;
  }

  /**
   * Rebuild books from journalled inputs, then republish recovered fills with
   * the original sequence idempotency keys. Does not invent fills.
   */
  async recover(): Promise<{ records: number; markets: number }> {
    const records: readonly JournalRecord[] = this.journal.read();
    this.books.clear();
    this.halted.clear();
    this.venueHalted = false;
    this.reduceOnlyMarkets.clear();
    this.postOnlyMarkets.clear();
    this.prelaunchMarkets.clear();
    this.expiredMarkets.clear();
    this.delistedMarkets.clear();
    this.deadSessions.clear();
    this.inFlight.clear();
    const replayed = replayJournal(records);
    for (const [marketId, book] of replayed.books) this.books.set(marketId, book);
    this.venueHalted = replayVenueHalted(records);
    for (const marketId of replayHaltedMarkets(records)) this.halted.add(marketId);
    for (const marketId of replayReduceOnlyMarkets(records)) this.reduceOnlyMarkets.add(marketId);
    for (const marketId of replayPostOnlyMarkets(records)) this.postOnlyMarkets.add(marketId);
    for (const marketId of replayPrelaunchMarkets(records)) this.prelaunchMarkets.add(marketId);
    for (const marketId of replayExpiredMarkets(records)) this.expiredMarkets.add(marketId);
    for (const marketId of replayDelistedMarkets(records)) this.delistedMarkets.add(marketId);
    for (const sessionId of replayDeadSessions(records)) this.deadSessions.add(sessionId);
    for (const [orderId, mark] of replayInFlight(records)) this.inFlight.set(orderId, mark);
    await this.emit(replayed.fills.map((row) => filledEvent(row.marketId, row.fill, row.at)));
    return { records: records.length, markets: this.books.size };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  isHalted(marketId: MarketId): boolean {
    return this.halted.has(marketId);
  }

  get isVenueHalted(): boolean {
    return this.venueHalted;
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

  get markets(): readonly MarketId[] {
    return [...this.books.keys()].sort();
  }

  /**
   * Depth for a market, or null if it has never traded.
   * `limit` is required. Unset refuses (never invent 50). Owner-explicit 50 is a published window.
   */
  depth(marketId: MarketId, limit?: number | null): ReturnType<OrderBook['depth']> | null {
    const n = publishedEngineL2Limit(limit);
    return this.existingBook(marketId)?.depth(n) ?? null;
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
        if (this.venueHalted) {
          const result = venueHaltedSubmitResult(order.orderId);
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

  async cancel(marketId: MarketId, orderId: OrderId): Promise<CancelResult> {
    return withEngineSpan('matching.cancel', { marketId, orderId }, async (): Promise<CancelResult & { fillCount: number }> => {
      const inFlightCancel = this.refuseInFlightCancel(orderId);
      if (inFlightCancel) return { ...inFlightCancel, fillCount: 0 };

      const existing = this.existingBook(marketId);
      if (!existing) {
        return { cancelled: false, orderId, sequence: null, cancellation: null, fillCount: 0 };
      }

      const at = this.clock().toISOString();
      this.beginInFlight(marketId, orderId, 'cancel', at);
      this.journal.append({ kind: 'cancel', marketId, at, orderId });

      const result = existing.cancel(orderId);
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
        if (!book) continue;
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
    if (this.venueHalted) return venueHaltedAmendResult(cmd.orderId);
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

  async halt(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketHaltResult> {
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
      this.halted.add(marketId);
      return { accepted: true, marketId, halted: true, operatorId, confirmOperatorId };
    });
  }

  async resume(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketHaltResult> {
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
      return { accepted: true, marketId, halted: false, operatorId, confirmOperatorId };
    });
  }

  async haltAll(cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null }): Promise<VenueKillResult> {
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
      this.venueHalted = true;
      return { accepted: true, halted: true, operatorId, confirmOperatorId };
    });
  }

  async resumeAll(cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null }): Promise<VenueKillResult> {
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
      return { accepted: true, marketId, prelaunch: false, operatorId, confirmOperatorId };
    });
  }

  async expire(
    marketId: MarketId,
    cmd: { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null },
  ): Promise<MarketExpireResult> {
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
      for (const fill of fills) events.push(filledEvent(marketId, fill, at));
      for (const cancellation of cancellations) events.push(cancelledEvent(marketId, cancellation));
    };

    collect(result.fills, result.cancellations);
    for (const triggered of result.triggered as readonly TriggerOutcome[]) collect(triggered.fills, triggered.cancellations);

    return events.sort((a, b) => a.sequence - b.sequence);
  }

  private eventsForAmend(marketId: MarketId, result: AmendResult, at: string): PendingEvent[] {
    const events: PendingEvent[] = [];
    for (const cancellation of result.cancellations) events.push(cancelledEvent(marketId, cancellation));
    if (!result.accepted) return events.sort((a, b) => a.sequence - b.sequence);
    for (const fill of result.fills) events.push(filledEvent(marketId, fill, at));
    for (const triggered of result.triggered as readonly TriggerOutcome[]) {
      for (const fill of triggered.fills) events.push(filledEvent(marketId, fill, at));
      for (const cancellation of triggered.cancellations) events.push(cancelledEvent(marketId, cancellation));
    }
    return events.sort((a, b) => a.sequence - b.sequence);
  }

  private async emit(events: readonly PendingEvent[]): Promise<void> {
    for (const event of events) {
      const opts = { idempotencyKey: event.key };
      switch (event.name) {
        case 'orderAccepted':
          await this.bus.publish('orderAccepted', event.payload, opts);
          break;
        case 'orderFilled':
          await this.bus.publish('orderFilled', event.payload, opts);
          break;
        case 'orderCancelled':
          await this.bus.publish('orderCancelled', event.payload, opts);
          break;
      }
    }
  }

  private async maybeSnapshot(): Promise<void> {
    if (this.snapshotEvery <= 0) return;
    if (this.journal.length % this.snapshotEvery !== 0) return;
    await this.sink.write(this.snapshot());
  }
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
    },
    key: `matching.order.cancelled:${marketId}:${cancellation.sequence}`,
  };
}

/** Unset snapshot cadence refuses. Never invent 500. Owner-explicit 0 disables. */
function publishedSnapshotEvery(value: number | undefined | null): number {
  if (value === undefined || value === null) {
    throw new Error('MatchingEngine snapshotEvery is unset — refuse to invent 500');
  }
  return value;
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
