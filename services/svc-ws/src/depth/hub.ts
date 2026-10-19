import { formatAmount } from '@intafaced/ledger-client/money';
import {
  bookFromSnapshot,
  diffDepth,
  type DepthBook,
  type DepthDelta,
  type DepthSide,
  type DepthSnapshot,
  type WireLevel,
} from '@intafaced/market-data';
import { resolveWsCopy, WS_COPY } from '../copy.js';
import { isPublishedDepthLimit } from '../depth-limit.js';
import { isPublishedHighWaterBytes } from '../high-water-bytes.js';
import { isPublishedConnectionCeiling } from '../max-connections.js';
import { isPublishedMaxLagTicks } from '../max-lag-ticks.js';
import {
  confirmsTradingResume,
  DEPTH_VENUE_HALTED,
  depthMatchingTradingFrame,
  type MatchingTradingResumeEvidence,
  type DepthMatchingTradingCode,
} from '../matching-trading.js';
import type { MarketRegistry } from './registry.js';
import { bookIsCrossed } from './crossed.js';
import { DepthNoBookError, type DepthSource } from './source.js';

/** True when both sides have the same prices with the same quantities. */
function sidesEqual(a: DepthSide, b: DepthSide): boolean {
  if (a.size !== b.size) return false;
  for (const [price, qty] of a) {
    if (b.get(price) !== qty) return false;
  }
  return true;
}

/**
 * THE FAN-OUT (§5.2 ws.gateway).
 *
 * One book per subscribed market, one snapshot per connection, one delta per
 * sequence advance, to everyone watching. No I/O of its own beyond the
 * `DepthSource` port and no timer — the caller drives the clock, so every
 * behaviour below is reachable from a test without waiting for one.
 *
 * ── The contract this must not break ────────────────────────────────────────
 *
 * The wire format is `DepthMessage` from `@intafaced/market-data`, unchanged and
 * not extended. Deltas are computed by `diffDepth`, which the browser's
 * `applyDelta` is the exact inverse of, and both come from the same package —
 * so a client that misses a frame does not have to be told, it can tell. A
 * delta whose `fromSequence` does not match the book it lands on is REFUSED by
 * the client and it resnapshots. Every drop policy below leans on that, which
 * is why none of them is allowed to renumber anything.
 *
 * ── Backpressure: degrade, then disconnect ──────────────────────────────────
 *
 * A market-data server dies from one of two things: an unbounded per-client
 * queue, or a slow client holding up the fan-out. This keeps **no per-client
 * queue at all** once a subscription is live. When a socket's own outbound
 * buffer is over the high-water mark:
 *
 *   1. the delta is DROPPED, not queued. Dropping is safe here and only here,
 *      because the next frame the client accepts will not line up and its own
 *      gap check fires. Silence is never the failure mode — see (2).
 *   2. the client is marked lagging. On the first tick where its buffer has
 *      drained, it gets a full SNAPSHOT rather than the deltas it missed. The
 *      lag sweep runs on every tick, including ticks where nothing changed, so
 *      a client that lagged into a quiet market still gets repaired instead of
 *      sitting on a book it believes is current.
 *   3. a client that is still over the mark after `maxLagTicks` consecutive
 *      ticks cannot absorb a top-N book in several seconds. That is not a
 *      trading client, and it is disconnected. Coalescing forever would let one
 *      dead TCP connection pin a book snapshot per tick indefinitely.
 *
 * Replaying missed deltas was the alternative and it is the wrong trade: the
 * replay buffer is unbounded in exactly the case you need it (a client that is
 * slow *because* the market is fast), while a snapshot is bounded by
 * `WS_DEPTH_LIMIT` and repairs any amount of lag in one frame.
 *
 * ── Snapshot-then-delta ordering ────────────────────────────────────────────
 *
 * A connection is registered BEFORE its snapshot is produced, because the other
 * order loses every delta that lands in the gap. Between registration and the
 * first frame, deltas are buffered rather than sent — if one went out first the
 * client would have no book to apply it to and would drop it, which is the
 * classic bug. The snapshot is then taken from the hub's CURRENT book at flush
 * time, not from whatever was current when the connection opened, so the
 * buffered deltas are normally already inside it and are discarded by
 * sequence. The replay loop still exists and still runs; it is a guard on an
 * invariant, not decoration, and there is a test that drives frames through
 * `applyDelta` to prove the client can rebuild the server's exact book.
 */

/** What the hub needs from a socket. Real sockets and fakes both satisfy it. */
export interface DepthSink {
  /** Bytes handed to the socket and not yet flushed to the peer. */
  readonly bufferedBytes: number;
  send(frame: string): void;
  close(code: number, reason: string): void;
}

/** RFC 6455 close codes, used for their actual meanings. */
export const CLOSE_POLICY = 1008;
export const CLOSE_TRY_LATER = 1013;
export const CLOSE_GOING_AWAY = 1001;

/**
 * Named unavailability on a public door — NOT a `DepthMessage` field.
 * Matching-down / seed-fail must not look like a live empty book (seq-0 snapshot).
 * Control frame `{ type: 'status', code }` sits beside snapshot/delta; the
 * market-data package still forbids extending `DepthMessage`.
 */
export const DEPTH_ENGINE_UNAVAILABLE = 'depth.engine_unavailable' as const;

export interface DepthEngineStatusFrame {
  readonly type: 'status';
  readonly code: typeof DEPTH_ENGINE_UNAVAILABLE;
  readonly marketId: string;
}

export function depthEngineUnavailableFrame(marketId: string): string {
  const frame: DepthEngineStatusFrame = { type: 'status', code: DEPTH_ENGINE_UNAVAILABLE, marketId };
  return JSON.stringify(frame);
}

export interface DepthHubOptions {
  /** Owner-published L2 top-N. Unset = unpublished; attach refuses. */
  readonly depthLimit: number | undefined;
  /** Owner-published lag buffer bound. Unset = unpublished; attach refuses. Never invent 1048576. */
  readonly highWaterBytes: number | undefined;
  /** Owner-published lag ticks. Unset = unpublished; attach refuses. Never invent 20. */
  readonly maxLagTicks: number | undefined;
  readonly maxConnections: number | undefined;
  /**
   * Seat pool for multiplexed subscriptions, separate from `maxConnections`
   * (the pool the original `?market=` sockets use). Unset refuses a multiplexed
   * attach `ws.close.mux_max_seats_unset`. Never counted against the market door.
   */
  readonly muxMaxConnections?: number | undefined;
  /** How long a cached market list is trusted before a miss may refetch it. */
  readonly marketsRefreshMs: number;
  /**
   * WHICH MARKETS A CLIENT MAY SUBSCRIBE TO.
   *
   * Defaults to the `DepthSource` itself, which is svc-matching's
   * `engine.markets`. That default is wrong in production and right in tests:
   * a test that drives a fake source wants one list, and the fleet wants the
   * LISTING — the engine's list is the books that have traded, which excluded
   * every id the browser could actually discover (see `registry.ts` for the
   * empty-intersection this fixed). `index.ts` passes a `UnionMarketRegistry`
   * over the listing service and the engine.
   */
  readonly registry?: MarketRegistry;
  /**
   * Deltas that may pile up between registration and the first frame. They are
   * normally all subsumed by the snapshot, so overflowing this is a symptom
   * (an upstream stalled mid-connect), not a loss — the buffer is cleared and
   * the snapshot still carries the truth.
   */
  readonly maxPendingDeltas?: number;
  /** Injected in tests, so the market-list cache window is not wall-clock. */
  readonly clock?: () => number;
  /**
   * Fires when matching availability flips (any-market down ↔ all clear).
   * Private orders stream uses this so kill-matching is named, not a blank blotter.
   */
  readonly onMatchingAvailabilityChange?: (available: boolean) => void;
  /**
   * Fires when matching trading status for one market flips (tradable ↔ named
   * halt/prelaunch/expire/delist). Private seats get the orders.* name.
   */
  readonly onMatchingTradingChange?: (
    marketId: string,
    code: DepthMatchingTradingCode | null,
    confirmedOpen?: MatchingTradingResumeEvidence,
  ) => void;
}

export interface HubLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface Subscription {
  readonly marketId: string;
  readonly sink: DepthSink;
  /** Holds a multiplexed seat (counted against `muxMaxConnections`, not `maxConnections`). */
  readonly mux: boolean;
  /** Non-null until the snapshot has been sent. Deltas queue here, in order. */
  pending: DepthDelta[] | null;
  /** Consecutive ticks spent above the high-water mark. */
  lagTicks: number;
  /** True when at least one delta has been dropped and not yet repaired. */
  lagging: boolean;
  closed: boolean;
}

/** A book back onto the wire. Prices are map keys, so they pass through verbatim. */
export function toSnapshot(book: DepthBook): DepthSnapshot {
  const side = (levels: DepthBook['bids']): WireLevel[] => [...levels].map(([price, qty]) => [price, formatAmount(qty)] as WireLevel);
  return { type: 'snapshot', marketId: book.marketId, sequence: book.sequence, bids: side(book.bids), asks: side(book.asks) };
}

/** Resting depth on either side. Empty sides are absence, not a live zero book. */
export function snapshotHasRestingDepth(snapshot: DepthSnapshot): boolean {
  const book = bookFromSnapshot(snapshot);
  return book.bids.size > 0 || book.asks.size > 0;
}

function bookHasRestingDepth(book: DepthBook): boolean {
  return book.bids.size > 0 || book.asks.size > 0;
}

const NO_LOG: HubLogger = { info: () => undefined, warn: () => undefined };

export class DepthHub {
  readonly #source: DepthSource;
  readonly #registry: MarketRegistry;
  readonly #options: Required<
    Omit<DepthHubOptions, 'registry' | 'muxMaxConnections' | 'onMatchingAvailabilityChange' | 'onMatchingTradingChange'>
  >;
  readonly #onMatchingAvailabilityChange?: (available: boolean) => void;
  readonly #onMatchingTradingChange?: (
    marketId: string,
    code: DepthMatchingTradingCode | null,
    confirmedOpen?: MatchingTradingResumeEvidence,
  ) => void;
  readonly #log: HubLogger;
  readonly #muxMax: number | undefined;

  readonly #subscriptions = new Set<Subscription>();
  readonly #books = new Map<string, DepthBook>();
  /** In-flight cold-start fetches, so N simultaneous connections cost one GET. */
  readonly #seeding = new Map<string, Promise<void>>();

  #knownMarkets: ReadonlySet<string> = new Set();
  #marketsFetchedAt = 0;
  /**
   * Last time a miss on the known-market list triggered a refresh.
   * Separate from `#marketsFetchedAt` (timer / successful list load) so a
   * freshly listed market still gets one refetch per window even when the
   * cache was warmed moments ago by a different path.
   */
  #missRefreshAt = 0;
  #marketsInFlight: Promise<void> | null = null;

  /** Counters, surfaced on `/ready` so a flaky client is visible to an operator. */
  #droppedFrames = 0;
  #evictions = 0;
  #repairs = 0;
  /**
   * Markets whose last depth read failed (matching down / seed-fail / 5xx).
   * Distinct from a listed never-traded book (honest empty at sequence 0).
   */
  readonly #unavailable = new Set<string>();
  /** Matching is up and refusing submits. Named — never a tradable ladder. */
  readonly #trading = new Map<string, DepthMatchingTradingCode>();

  constructor(source: DepthSource, options: DepthHubOptions, log: HubLogger = NO_LOG) {
    const { registry, onMatchingAvailabilityChange, onMatchingTradingChange, muxMaxConnections, ...rest } = options;
    this.#muxMax = muxMaxConnections;
    this.#source = source;
    this.#registry = registry ?? source;
    this.#options = { maxPendingDeltas: 512, clock: Date.now, ...rest };
    this.#onMatchingAvailabilityChange = onMatchingAvailabilityChange;
    this.#onMatchingTradingChange = onMatchingTradingChange;
    this.#log = log;
  }

  get connections(): number {
    return this.#subscriptions.size;
  }

  /** Seats held by multiplexed subscriptions (a separate pool from `maxConnections`). */
  get muxConnections(): number {
    return this.#seats(true);
  }

  get muxMaxConnections(): number | undefined {
    return this.#muxMax;
  }

  #seats(mux: boolean): number {
    let n = 0;
    for (const sub of this.#subscriptions) if (sub.mux === mux) n += 1;
    return n;
  }

  /** Per-hub seat ceiling (same bound attach enforces). Not process-wide. Unset = unpublished. */
  get maxConnections(): number | undefined {
    return this.#options.maxConnections;
  }

  /** Markets with at least one subscriber — exactly what the poller should poll. */
  get activeMarkets(): string[] {
    const active = new Set<string>();
    for (const sub of this.#subscriptions) if (!sub.closed) active.add(sub.marketId);
    return [...active];
  }

  get matchingAvailable(): boolean {
    return this.#unavailable.size === 0;
  }

  get engineCode(): typeof DEPTH_ENGINE_UNAVAILABLE | null {
    return this.matchingAvailable ? null : DEPTH_ENGINE_UNAVAILABLE;
  }

  isEngineUnavailable(marketId: string): boolean {
    return this.#unavailable.has(marketId);
  }

  matchingTrading(marketId: string): DepthMatchingTradingCode | null {
    return this.#trading.get(marketId) ?? null;
  }

  isMatchingNotTradable(marketId: string): boolean {
    return this.#trading.has(marketId);
  }

  get stats(): {
    connections: number;
    books: number;
    droppedFrames: number;
    evictions: number;
    repairs: number;
    matchingAvailable: boolean;
    code: typeof DEPTH_ENGINE_UNAVAILABLE | null;
  } {
    return {
      connections: this.#subscriptions.size,
      books: this.#books.size,
      droppedFrames: this.#droppedFrames,
      evictions: this.#evictions,
      repairs: this.#repairs,
      matchingAvailable: this.matchingAvailable,
      code: this.engineCode,
    };
  }

  get knownMarkets(): readonly string[] {
    return [...this.#knownMarkets].sort();
  }

  // ── Subscription ──────────────────────────────────────────────────────────

  /**
   * Register a sink for a market. Returns its own detach.
   *
   * Synchronous on purpose: the caller is a socket `connection` handler and must
   * not have to await anything before it can wire up `close`. The snapshot is
   * produced on a later turn, and the buffering above is what makes that safe.
   */
  /**
   * Register a sink. Returns detach, or `null` when at capacity (sink already
   * closed with 1013). Callers that open real sockets must terminate on null —
   * same fail-closed shape as the private hub (no half-open with zero frames).
   */
  attach(marketId: string, sink: DepthSink, options: { readonly mux?: boolean } = {}): (() => void) | null {
    const mux = options.mux === true;
    if (!isPublishedDepthLimit(this.#options.depthLimit)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.depthLimitUnset));
      return null;
    }
    if (!isPublishedHighWaterBytes(this.#options.highWaterBytes)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.highWaterBytesUnset));
      return null;
    }
    if (!isPublishedMaxLagTicks(this.#options.maxLagTicks)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.maxLagTicksUnset));
      return null;
    }
    const max = mux ? this.#muxMax : this.#options.maxConnections;
    if (!isPublishedConnectionCeiling(max)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(mux ? WS_COPY.muxMaxSeatsUnset : WS_COPY.maxConnectionsUnset));
      return null;
    }
    if (this.#seats(mux) >= max) {
      sink.close(CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.atCapacity));
      return null;
    }

    const sub: Subscription = { marketId, sink, mux, pending: [], lagTicks: 0, lagging: false, closed: false };
    this.#subscriptions.add(sub);
    void this.#open(sub);

    return () => {
      sub.closed = true;
      this.#subscriptions.delete(sub);
      this.#forgetIdleBook(marketId);
    };
  }

  async #open(sub: Subscription): Promise<void> {
    try {
      if (!(await this.ensureKnownMarket(sub.marketId))) {
        // Not listed anywhere. Typed close — never a fabricated empty ladder.
        // A LISTED market with no book stays open with no snapshot until
        // matching has resting depth (empty ≠ zero).
        this.#evict(sub, CLOSE_POLICY, resolveWsCopy(WS_COPY.unknownMarket));
        return;
      }
      if (sub.closed) return;

      if (!this.#books.has(sub.marketId)) await this.#seed(sub.marketId);
      if (sub.closed) {
        // Gave up during the round trip. The seed still landed a book, and a
        // book nobody is watching must not be left behind to go stale.
        this.#forgetIdleBook(sub.marketId);
        return;
      }

      if (!this.#books.has(sub.marketId)) {
        // Listed, no proven book. Never-traded (404 / empty ingest) stays
        // silent absence. Engine-down is named so a terminal cannot confuse
        // the two.
        if (this.isEngineUnavailable(sub.marketId)) {
          this.#write(sub, depthEngineUnavailableFrame(sub.marketId));
        } else if (this.isMatchingNotTradable(sub.marketId)) {
          this.#write(sub, depthMatchingTradingFrame(sub.marketId, this.#trading.get(sub.marketId)!));
        }
        return;
      }

      // Engine-down wins over a halt name. A halt frame must not be the door
      // that later flushes the cached ladder, and the subscriber is told
      // matching is down even when the market is also halted.
      if (this.isEngineUnavailable(sub.marketId)) {
        this.#write(sub, depthEngineUnavailableFrame(sub.marketId));
        return;
      }

      if (this.isMatchingNotTradable(sub.marketId)) {
        this.#write(sub, depthMatchingTradingFrame(sub.marketId, this.#trading.get(sub.marketId)!));
        return;
      }

      if (sub.pending !== null) this.#flush(sub);
    } catch (err) {
      this.#evict(sub, CLOSE_TRY_LATER, err instanceof Error ? err.message : 'depth unavailable');
    }
  }

  /**
   * Is this a market anybody lists?
   *
   * The cached list is refreshed lazily on a miss, at most once per refresh
   * window, so a market listed a moment ago works without waiting for the timer
   * and a flood of junk ids costs at most one upstream call per window.
   *
   * Miss-refresh is gated on `#missRefreshAt`, not on the last successful list
   * load: a timer-driven or first-connect refresh must not block a miss for a
   * market that was listed after that load.
   */
  async ensureKnownMarket(marketId: string): Promise<boolean> {
    if (this.#knownMarkets.has(marketId)) return true;

    // Join an in-flight list load first. Concurrent misses must share that
    // refresh — otherwise the second caller hits the budget path and gets a
    // false "unknown market" while the first is still fetching a list that
    // already includes the id.
    if (this.#marketsInFlight) {
      await this.#marketsInFlight;
      if (this.#knownMarkets.has(marketId)) return true;
    }

    const now = this.#options.clock();
    // Already spent this window's miss-refresh budget. `marketsRefreshMs: 0`
    // never holds (now - t < 0 is false), so every miss still refetches.
    // If a refresh is somehow still in flight, join it rather than refuse.
    if (this.#missRefreshAt !== 0 && now - this.#missRefreshAt < this.#options.marketsRefreshMs) {
      if (this.#marketsInFlight) {
        await this.#marketsInFlight;
        return this.#knownMarkets.has(marketId);
      }
      return false;
    }

    this.#missRefreshAt = now;
    try {
      await this.refreshMarkets();
    } catch (err) {
      // A failed list load is not "we checked and it is not a market" — clear
      // the budget so the next miss can retry instead of lying for the window.
      this.#missRefreshAt = 0;
      throw err;
    }
    return this.#knownMarkets.has(marketId);
  }

  async refreshMarkets(): Promise<void> {
    // Deduped: a burst of connections for a new market must not become a burst
    // of `GET /markets`.
    const inFlight = this.#marketsInFlight;
    if (inFlight) return inFlight;

    const run = (async () => {
      try {
        const markets = await this.#registry.markets();
        this.#knownMarkets = new Set(markets);
        this.#marketsFetchedAt = this.#options.clock();
      } finally {
        this.#marketsInFlight = null;
      }
    })();
    this.#marketsInFlight = run;
    return run;
  }

  async #seed(marketId: string): Promise<void> {
    const inFlight = this.#seeding.get(marketId);
    if (inFlight) return inFlight;

    const run = (async () => {
      try {
        const limit = this.#options.depthLimit;
        if (!isPublishedDepthLimit(limit)) return;
        const snapshot = await this.#source.snapshot(marketId, limit);
        // Poll may have already written a newer book while the seed round-trip
        // was in flight. A seed must never regress that book.
        const existing = this.#books.get(marketId);
        if (existing !== undefined && existing.sequence > snapshot.sequence) {
          this.#log.warn(
            { marketId, seedSequence: snapshot.sequence, bookSequence: existing.sequence },
            'ws: seed snapshot older than current book — skipped',
          );
          return;
        }
        const trading = this.#source.trading?.(marketId) ?? null;
        this.#setTrading(marketId, trading, this.#source.tradingOpenEvidence?.(marketId) ?? false);
        this.ingest(snapshot);
      } catch (err) {
        // Listed, but matching has no book or is down. Do not invent
        // `{ bids: [], asks: [], sequence: 0 }` — that is a live zero book.
        // 404 / DepthNoBookError = honest absence. Anything else = engine-down,
        // named on the socket + `/ready` so it is not silent.
        if (!(err instanceof DepthNoBookError)) this.#noteEngineDown(marketId);
        this.#log.warn(
          { marketId, err: err instanceof Error ? err.message : String(err) },
          err instanceof DepthNoBookError
            ? 'ws: depth seed — matching holds no book (absence, not engine-down)'
            : 'ws: depth seed failed — disclosing depth.engine_unavailable; poll will replace when matching recovers',
        );
      } finally {
        this.#seeding.delete(marketId);
      }
    })();
    this.#seeding.set(marketId, run);
    return run;
  }

  /** Nothing is watching this market any more, so its book stops being truth. */
  #forgetIdleBook(marketId: string): void {
    if (this.#hasLiveSubscriber(marketId)) return;
    // Kept only while someone is watching. A book left behind goes stale, and a
    // stale book handed to the next connection as a "snapshot" is a lie with a
    // sequence number on it.
    this.#books.delete(marketId);
  }

  #hasLiveSubscriber(marketId: string): boolean {
    for (const sub of this.#subscriptions) if (!sub.closed && sub.marketId === marketId) return true;
    return false;
  }

  // ── The tick ──────────────────────────────────────────────────────────────

  /**
   * Take a fresh upstream snapshot as the new truth and tell everyone what
   * changed. Call this on every poll tick, even when nothing has changed — the
   * lag repair sweep rides on it.
   *
   * Returns the delta that was broadcast, or `null` when there was none.
   */
  ingest(snapshot: DepthSnapshot): DepthDelta | null {
    this.#noteEngineUp(snapshot.marketId);
    // A poll samples activeMarkets, then the last watcher can leave and
    // #forgetIdleBook deletes the book before this snapshot arrives. Storing
    // it would make the next #open skip #seed and flush that leftover ladder.
    // Both stores below — the not-tradable keep and the normal book — wait
    // until someone is still watching.
    if (!this.#hasLiveSubscriber(snapshot.marketId)) return null;
    const previous = this.#books.get(snapshot.marketId);
    const next = bookFromSnapshot(snapshot);
    if (bookIsCrossed(next)) {
      // Best bid at or above the best ask is a bad copy. Do not replace a
      // live book with it and do not fan a snapshot of it.
      this.#log.warn({ marketId: snapshot.marketId, sequence: snapshot.sequence }, 'ws: crossed book withheld — not offered as live');
      return null;
    }
    if (this.isMatchingNotTradable(snapshot.marketId)) {
      // Keep the book current for resume. Do not fan out a tradable ladder.
      if (bookHasRestingDepth(next) || previous) this.#books.set(snapshot.marketId, next);
      return null;
    }
    if (!previous && !bookHasRestingDepth(next)) {
      // No prior book and no resting depth: absent, not a priced empty book.
      return null;
    }
    this.#books.set(snapshot.marketId, next);

    if (!previous) {
      this.#fanOut(next, null);
      return null;
    }

    if (next.sequence < previous.sequence) {
      // The engine went backwards. A sequence cannot un-happen, so this is a
      // replica behind its peers or an engine that lost its journal — either
      // way our book is no longer derived from anything. Everyone gets a
      // snapshot; nobody gets a delta computed across the discontinuity, which
      // would carry a `fromSequence` no client could ever be at.
      this.#log.warn({ marketId: snapshot.marketId, was: previous.sequence, now: next.sequence }, 'ws: upstream sequence went backwards');
      this.#fanOut(next, null, true);
      return null;
    }

    if (next.sequence === previous.sequence) {
      // Same sequence, different levels: the book we hold is wrong and a
      // continuous delta cannot fix it (fromSequence would equal sequence).
      // Force a repair snapshot so clients do not silently drift. Identical
      // levels still fan out null so the lag-repair sweep still runs.
      if (!sidesEqual(previous.bids, next.bids) || !sidesEqual(previous.asks, next.asks)) {
        this.#log.warn(
          { marketId: snapshot.marketId, sequence: next.sequence },
          'ws: same-sequence level change — forcing snapshot repair',
        );
        this.#fanOut(next, null, true);
      } else {
        this.#fanOut(next, null);
      }
      return null;
    }

    // A sequence that advanced with no visible level change still gets a delta.
    // Skipping it would leave every client behind the engine, and the NEXT real
    // delta would then gap and cost everyone a resnapshot. An empty delta is a
    // few bytes; a fleet-wide resnapshot is not.
    const delta = diffDepth(previous, next);
    this.#fanOut(next, delta);
    return delta;
  }

  #fanOut(book: DepthBook, delta: DepthDelta | null, forceRepair = false): void {
    // A resume that clears a halt before ingest must not broadcast the cached
    // ladder while matching is still down. ingest clears the flag first, then
    // fans out the new book.
    if (this.isEngineUnavailable(book.marketId)) return;
    if (this.isMatchingNotTradable(book.marketId)) return;
    let snapshotFrame: string | null = null;
    const snapshot = (): string => (snapshotFrame ??= JSON.stringify(toSnapshot(book)));
    const deltaFrame = delta === null ? null : JSON.stringify(delta);

    for (const sub of [...this.#subscriptions]) {
      if (sub.closed || sub.marketId !== book.marketId) continue;

      if (sub.pending !== null) {
        if (delta !== null) this.#queue(sub, delta);
        if (bookHasRestingDepth(book)) this.#flush(sub);
        continue;
      }

      if (isPublishedHighWaterBytes(this.#options.highWaterBytes) && sub.sink.bufferedBytes > this.#options.highWaterBytes) {
        sub.lagging = true;
        sub.lagTicks += 1;
        if (delta !== null) this.#droppedFrames += 1;
        if (isPublishedMaxLagTicks(this.#options.maxLagTicks) && sub.lagTicks >= this.#options.maxLagTicks) {
          this.#evictions += 1;
          this.#evict(
            sub,
            CLOSE_TRY_LATER,
            `slow consumer: outbound buffer over ${this.#options.highWaterBytes} bytes for ${sub.lagTicks} ticks`,
          );
        }
        continue;
      }

      sub.lagTicks = 0;

      if (sub.lagging || forceRepair) {
        // It missed frames (or the whole stream discontinued). A snapshot
        // repairs any amount of lag in one message; the deltas it missed are
        // gone and will never be sent, because they are already in this.
        sub.lagging = false;
        this.#repairs += 1;
        this.#write(sub, snapshot());
        continue;
      }

      if (deltaFrame !== null) this.#write(sub, deltaFrame);
    }
  }

  #queue(sub: Subscription, delta: DepthDelta): void {
    const pending = sub.pending;
    if (pending === null) return;
    pending.push(delta);
    if (pending.length <= this.#options.maxPendingDeltas) return;

    // Safe to discard: the snapshot sent at flush time is taken from the book
    // these deltas were derived from, so it already contains every one of them.
    // Clearing bounds the memory a stalled connect can cost.
    sub.pending = [];
    this.#log.warn({ marketId: sub.marketId }, 'ws: pending delta buffer overflowed during connect — snapshot still carries them');
  }

  /** Send the snapshot, then whatever the stream sent while we were producing it. */
  #flush(sub: Subscription): void {
    if (sub.closed || sub.pending === null) return;
    // Leave pending in place. A later ingest, after the outage clears, still
    // flushes the new snapshot. Sending the cached ladder here would look live.
    if (this.isEngineUnavailable(sub.marketId)) return;
    if (this.isMatchingNotTradable(sub.marketId)) return;
    const book = this.#books.get(sub.marketId);
    if (!book || !bookHasRestingDepth(book)) {
      // Listed, no live book yet. Stay open with no frames — do not emit []
      // and do not close as unknown. Poll / a later ingest flushes for real.
      return;
    }

    const buffered = (sub.pending ?? []).slice().sort((a, b) => a.sequence - b.sequence);
    sub.pending = null;

    this.#write(sub, JSON.stringify(toSnapshot(book)));

    let cursor = book.sequence;
    for (const delta of buffered) {
      // Already inside the snapshot — the normal case, because the snapshot is
      // taken from the book after every one of these was applied to it.
      if (delta.sequence <= cursor) continue;
      // Does not continue the snapshot. Stop: sending it would be a frame the
      // client must refuse anyway, and the next broadcast delta will trip its
      // gap check and resnapshot it properly.
      if (delta.fromSequence !== cursor) break;
      this.#write(sub, JSON.stringify(delta));
      cursor = delta.sequence;
    }
  }

  #write(sub: Subscription, frame: string): void {
    try {
      sub.sink.send(frame);
    } catch (err) {
      // A send that throws is a socket that is already gone. Dropping the
      // subscription here keeps one dead peer from being re-tried every tick.
      this.#evict(sub, CLOSE_GOING_AWAY, err instanceof Error ? err.message : 'send failed');
    }
  }

  #evict(sub: Subscription, code: number, reason: string): void {
    if (sub.closed) return;
    sub.closed = true;
    this.#subscriptions.delete(sub);
    try {
      sub.sink.close(code, reason);
    } catch {
      /* already gone */
    }
    this.#forgetIdleBook(sub.marketId);
  }

  /** Kill-switch, and shutdown. Every socket is told why. */
  closeAll(code: number, reason: string): void {
    for (const sub of [...this.#subscriptions]) this.#evict(sub, code, reason);
    this.#books.clear();
  }

  /** The current book for a market, if one is being maintained. */
  bookFor(marketId: string): DepthBook | undefined {
    return this.#books.get(marketId);
  }

  /**
   * A client asked for a fresh snapshot (the multiplexed door's `resync` verb).
   * It rides the same repair the lag sweep uses — a full `snapshot` of the
   * hub's CURRENT book — so it cannot disagree with the deltas that follow it:
   * both are written synchronously from the same book, and the next delta's
   * `fromSequence` is that snapshot's `sequence`.
   *
   *   · `pending`  the connect snapshot has not been written yet; it is the repair.
   *   · `deferred` the socket is over the high-water mark; the lag sweep repairs
   *                it on the first tick it has drained (a snapshot queued behind
   *                an unread backlog would make the backlog worse).
   *   · `absent`   no proven book. Nothing is invented; the client already knows.
   */
  resync(sink: DepthSink): 'sent' | 'pending' | 'deferred' | 'absent' | 'not_subscribed' {
    let sub: Subscription | undefined;
    for (const candidate of this.#subscriptions) {
      if (!candidate.closed && candidate.sink === sink) {
        sub = candidate;
        break;
      }
    }
    if (!sub) return 'not_subscribed';
    if (sub.pending !== null) return 'pending';
    if (this.isEngineUnavailable(sub.marketId)) {
      this.#write(sub, depthEngineUnavailableFrame(sub.marketId));
      return 'sent';
    }
    const trading = this.#trading.get(sub.marketId);
    if (trading !== undefined) {
      this.#write(sub, depthMatchingTradingFrame(sub.marketId, trading));
      return 'sent';
    }
    const book = this.#books.get(sub.marketId);
    if (!book || !bookHasRestingDepth(book)) return 'absent';
    if (isPublishedHighWaterBytes(this.#options.highWaterBytes) && sub.sink.bufferedBytes > this.#options.highWaterBytes) {
      sub.lagging = true;
      return 'deferred';
    }
    sub.lagging = false;
    sub.lagTicks = 0;
    this.#repairs += 1;
    this.#write(sub, JSON.stringify(toSnapshot(book)));
    return 'sent';
  }

  /** Matching answered (including 404 no-book). Clears engine-down for this id. */
  noteMatchingReachable(marketId: string): void {
    this.#noteEngineUp(marketId);
  }

  /**
   * Matching could not be read (timeout / 5xx / unreachable). Named disclosure
   * to current subscribers once per down-edge; `/ready` stays red until a
   * successful ingest.
   */
  markEngineUnavailable(marketId: string): void {
    const first = !this.#unavailable.has(marketId);
    this.#noteEngineDown(marketId);
    if (!first) return;
    const frame = depthEngineUnavailableFrame(marketId);
    for (const sub of [...this.#subscriptions]) {
      if (sub.closed || sub.marketId !== marketId) continue;
      this.#write(sub, frame);
    }
  }

  /**
   * Matching is up and this market is not taking submits. Named once per edge.
   * `null` with explicit confirmedOpen is matching OPEN again — the next resting book is a snapshot, never
   * invented prices.
   */
  noteMatchingTrading(marketId: string, code: DepthMatchingTradingCode | null, confirmedOpen: MatchingTradingResumeEvidence = false): void {
    const changed = this.#setTrading(marketId, code, confirmedOpen);
    if (!changed) return;
    if (code === null) {
      const book = this.#books.get(marketId);
      if (book && bookHasRestingDepth(book)) this.#fanOut(book, null, true);
      return;
    }
    const frame = depthMatchingTradingFrame(marketId, code);
    for (const sub of [...this.#subscriptions]) {
      if (sub.closed || sub.marketId !== marketId) continue;
      this.#write(sub, frame);
    }
  }

  /** Update matching trading map. Returns whether the named status changed. */
  #setTrading(marketId: string, code: DepthMatchingTradingCode | null, confirmedOpen: MatchingTradingResumeEvidence = false): boolean {
    const prev = this.#trading.get(marketId) ?? null;
    if (code === null && !confirmsTradingResume(confirmedOpen, prev === DEPTH_VENUE_HALTED)) return false;
    if (code === null) {
      if (prev === null) return false;
      this.#trading.delete(marketId);
      this.#onMatchingTradingChange?.(marketId, null, true);
      return true;
    }
    if (prev === code) return false;
    this.#trading.set(marketId, code);
    this.#onMatchingTradingChange?.(marketId, code);
    return true;
  }

  #noteEngineDown(marketId: string): void {
    const wasAvailable = this.#unavailable.size === 0;
    this.#unavailable.add(marketId);
    if (wasAvailable) this.#onMatchingAvailabilityChange?.(false);
  }

  #noteEngineUp(marketId: string): void {
    const wasAvailable = this.#unavailable.size === 0;
    this.#unavailable.delete(marketId);
    if (!wasAvailable && this.#unavailable.size === 0) this.#onMatchingAvailabilityChange?.(true);
  }
}
