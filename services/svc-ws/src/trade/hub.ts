import { tradePrintFromFill, type FillLike, type TradePrint } from '@intafaced/market-data';
import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_GOING_AWAY, CLOSE_POLICY, CLOSE_TRY_LATER, type DepthSink, type HubLogger } from '../depth/hub.js';
import { isPublishedHighWaterBytes } from '../high-water-bytes.js';
import { isPublishedConnectionCeiling } from '../max-connections.js';
import { isPublishedMaxLagTicks } from '../max-lag-ticks.js';
import { isPublishedTradeRecentLimit } from '../trade-recent-limit.js';

/**
 * Stated once. Public `side` on this tape is the taker side, the same meaning
 * the REST print uses. A fill that does not carry `takerSide` is sent without
 * `side` — the field is not invented from a maker side or from the book.
 */
export const PUBLIC_TAPE_SIDE_MEANING = 'taker' as const;

export function takerSideOf(fill: { readonly takerSide?: unknown }): 'buy' | 'sell' | undefined {
  return fill.takerSide === 'buy' || fill.takerSide === 'sell' ? fill.takerSide : undefined;
}

type StoredPrint = TradePrint & { readonly side?: 'buy' | 'sell' };

/**
 * TRADE TAPE FAN-OUT (§5.2 ws.gateway).
 *
 * Subscribers get public `TradePrint` frames only. Source is `orderFilled` on
 * the bus (wired in `trade/source.ts`); this hub never sees a principal, never
 * holds a balance, and never puts order ids on the wire — `tradePrintFromFill`
 * is the strip.
 *
 * ── Recent buffer, not a book ───────────────────────────────────────────────
 *
 * Depth needs a sequenced book. Trades do not: each print stands alone and
 * `sequence` is only a dedupe key. On connect we replay the last N prints for
 * the market **while someone is watching** so a mid-stream joiner is not empty,
 * then stream live. A ring bound (`recentLimit`) caps history for watched markets.
 * Unwatched markets store nothing — otherwise every `orderFilled` on the bus
 * would pin memory forever for markets nobody opened.
 *
 * ── Empty ≠ zero ────────────────────────────────────────────────────────────
 *
 * An unseeded tape, a matching 404, or a seed failure is **absence**. Emitting
 * `{ trades: [] }` (or a JSON `[]`) would let a client treat that as a live
 * zero-print market. Listed markets stay subscribed with no frames until a
 * real `TradePrint` exists. Unknown markets stay a typed close. Never invent
 * prints or mids.
 *
 * ── Backpressure ────────────────────────────────────────────────────────────
 *
 * Same policy as depth, simpler: over the high-water mark a print is dropped
 * (a tape that misses a print is still a valid tape; the next one is not a
 * gap in the depth sense), and a client still stuck after `maxLagTicks`
 * consecutive drops is disconnected. No per-client queue.
 */

/** Same shape as a depth sink — real sockets and fakes both satisfy it. */
export type TradeSink = DepthSink;

export interface TradeHubOptions {
  /** Owner-published lag buffer bound. Unset = unpublished; attach refuses. Never invent 1048576. */
  readonly highWaterBytes: number | undefined;
  /** Owner-published lag ticks. Unset = unpublished; attach refuses. Never invent 20. */
  readonly maxLagTicks: number | undefined;
  readonly maxConnections: number | undefined;
  /** Seat pool for multiplexed subscriptions, separate from `maxConnections`. Unset refuses a multiplexed attach. */
  readonly muxMaxConnections?: number | undefined;
  /** Owner-published replay window. Unset = unpublished; attach refuses. */
  readonly recentLimit: number | undefined;
  /**
   * Market-list gate. Same reason as depth: an arbitrary market id is not a
   * 404 on the engine, so we refuse anything not on the known list.
   */
  readonly ensureKnownMarket: (marketId: string) => Promise<boolean>;
  /**
   * Optional cold-start fetch (tests / future matching tape). Empty or throw
   * is absence — never stored as `[]`, never flushed as `{ trades: [] }`.
   */
  readonly seedRecent?: (marketId: string) => Promise<readonly TradePrint[]>;
}

/**
 * `{ trades: [] }` / JSON `[]` on the wire is a priced empty market. Empty
 * tape is absent: no frame, not a live zero print.
 */
export function isLiveZeroTapePayload(value: unknown): boolean {
  if (Array.isArray(value) && value.length === 0) return true;
  if (value !== null && typeof value === 'object' && 'trades' in value) {
    const trades = (value as { trades: unknown }).trades;
    return Array.isArray(trades) && trades.length === 0;
  }
  return false;
}

export function isLiveZeroTapeFrame(frame: string): boolean {
  try {
    return isLiveZeroTapePayload(JSON.parse(frame) as unknown);
  } catch {
    return false;
  }
}

interface Subscription {
  readonly marketId: string;
  readonly sink: TradeSink;
  /** Holds a multiplexed seat (counted against `muxMaxConnections`). */
  readonly mux: boolean;
  /** True until the recent-buffer replay has been written. */
  pending: boolean;
  lagTicks: number;
  closed: boolean;
}

const NO_LOG: HubLogger = { info: () => undefined, warn: () => undefined };

export class TradeHub {
  readonly #options: TradeHubOptions;
  readonly #log: HubLogger;

  readonly #subscriptions = new Set<Subscription>();
  /** Per-market ring of the most recent public prints. */
  readonly #recent = new Map<string, StoredPrint[]>();
  /** Sequences already accepted, so a JetStream redelivery is a no-op. */
  readonly #seen = new Map<string, Set<number>>();
  /** In-flight cold-start fetches — N connections cost one seed. */
  readonly #seeding = new Map<string, Promise<void>>();

  #droppedFrames = 0;
  #evictions = 0;
  #prints = 0;

  constructor(options: TradeHubOptions, log: HubLogger = NO_LOG) {
    this.#options = options;
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
    return this.#options.muxMaxConnections;
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

  /** Public tape replay length attach enforces. Unset = unpublished. */
  get recentLimit(): number | undefined {
    return this.#options.recentLimit;
  }

  get stats(): { connections: number; markets: number; prints: number; droppedFrames: number; evictions: number } {
    return {
      connections: this.#subscriptions.size,
      markets: this.#recent.size,
      prints: this.#prints,
      droppedFrames: this.#droppedFrames,
      evictions: this.#evictions,
    };
  }

  /** Recent public prints for a market, oldest first. */
  recentFor(marketId: string): readonly StoredPrint[] {
    return this.#recent.get(marketId) ?? [];
  }

  /**
   * Register a sink. Synchronous so the socket handler can wire `close` before
   * anything awaits. Recent prints flush on a later turn.
   */
  /**
   * Register a sink. Returns detach, or `null` when at capacity (sink already
   * closed with 1013). Real sockets must terminate on null — no half-open seat.
   */
  attach(marketId: string, sink: TradeSink, options: { readonly mux?: boolean } = {}): (() => void) | null {
    const mux = options.mux === true;
    if (!isPublishedTradeRecentLimit(this.#options.recentLimit)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.tradeRecentLimitUnset));
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
    const max = mux ? this.#options.muxMaxConnections : this.#options.maxConnections;
    if (!isPublishedConnectionCeiling(max)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(mux ? WS_COPY.muxMaxSeatsUnset : WS_COPY.maxConnectionsUnset));
      return null;
    }
    if (this.#seats(mux) >= max) {
      sink.close(CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.atCapacity));
      return null;
    }

    const sub: Subscription = { marketId, sink, mux, pending: true, lagTicks: 0, closed: false };
    this.#subscriptions.add(sub);
    void this.#open(sub);

    return () => {
      sub.closed = true;
      this.#subscriptions.delete(sub);
      this.#forgetIdleMarket(marketId);
    };
  }

  /**
   * Drop the recent ring and dedupe set when nobody is watching a market.
   * Depth forgets idle books the same way — keeping tape history forever would
   * pin memory for every market that ever printed, even after the last client left.
   * A later reconnect replays empty (honest), not a stale multi-hour buffer.
   */
  #forgetIdleMarket(marketId: string): void {
    for (const s of this.#subscriptions) {
      if (!s.closed && s.marketId === marketId) return;
    }
    this.#recent.delete(marketId);
    this.#seen.delete(marketId);
  }

  async #open(sub: Subscription): Promise<void> {
    try {
      if (!(await this.#options.ensureKnownMarket(sub.marketId))) {
        this.#evict(sub, CLOSE_POLICY, resolveWsCopy(WS_COPY.unknownMarket));
        return;
      }
      if (sub.closed) return;
      if (this.#options.seedRecent && !this.#recent.has(sub.marketId)) {
        await this.#seed(sub.marketId);
      }
      if (sub.closed) {
        this.#forgetIdleMarket(sub.marketId);
        return;
      }
      this.#flush(sub);
    } catch {
      this.#evict(sub, CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.tradesUnavailable));
    }
  }

  async #seed(marketId: string): Promise<void> {
    const inFlight = this.#seeding.get(marketId);
    if (inFlight) return inFlight;
    const seedRecent = this.#options.seedRecent;
    if (!seedRecent) return;

    // Register before seedRecent. A synchronous throw runs the finally before
    // a trailing set, and that set would keep the finished promise so the
    // next subscriber never retries.
    let finish!: () => void;
    const run = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#seeding.set(marketId, run);

    try {
      const prints = await seedRecent(marketId);
      if (prints.length === 0) {
        // Matching 404 / never printed: absence. Do not `#recent.set([],)`.
        this.#log.warn({ marketId }, 'ws: trade seed empty — no tape on the wire; live prints publish when they exist');
        return;
      }
      for (const print of prints) this.#acceptPrint(print);
    } catch (err) {
      this.#log.warn(
        { marketId, err: err instanceof Error ? err.message : String(err) },
        'ws: trade seed failed — no tape on the wire; matching 404 is absence not { trades: [] }',
      );
    } finally {
      this.#seeding.delete(marketId);
      finish();
    }
    return run;
  }

  /** Replay real prints only. An empty ring is silence, not `{ trades: [] }`. */
  #flush(sub: Subscription): void {
    if (sub.closed || !sub.pending) return;

    const ring = this.#recent.get(sub.marketId);
    if (ring && ring.length > 0) {
      for (const print of ring) {
        if (sub.closed) return;
        this.#write(sub, JSON.stringify(print));
      }
    }
    sub.pending = false;
  }

  /**
   * Ingest a fill-shaped payload (typically an `orderFilled` event). Returns
   * the public print that was stored, or `null` when it was a duplicate,
   * rejected by the shape check, or dropped because nobody is watching the market.
   */
  ingest(fill: FillLike & { readonly takerSide?: unknown }): TradePrint | null {
    let print: TradePrint;
    try {
      print = tradePrintFromFill(fill);
    } catch (err) {
      this.#log.warn(
        { err: err instanceof Error ? err.message : String(err), marketId: fill.marketId, sequence: fill.sequence },
        'ws: trade print rejected',
      );
      return null;
    }

    const side = takerSideOf(fill);
    const stored: StoredPrint = side === undefined ? print : { ...print, side };
    return this.#acceptPrint(stored);
  }

  #acceptPrint(print: StoredPrint): StoredPrint | null {
    const limit = this.#options.recentLimit;
    if (!isPublishedTradeRecentLimit(limit)) return null;

    // No watchers → no ring, no fan-out. Leaving the ring grow for idle markets
    // would re-pin memory after #forgetIdleMarket and for markets never opened.
    if (!this.#hasWatcher(print.marketId)) {
      return null;
    }

    const seen = this.#seen.get(print.marketId) ?? new Set<number>();
    if (seen.has(print.sequence)) return null;

    // Zero replay retains no sequence history. Wait for a live watcher so
    // opening seats do not consume prints they cannot receive.
    if (limit === 0 && !this.#hasLiveWatcher(print.marketId)) return null;
    seen.add(print.sequence);
    this.#seen.set(print.marketId, seen);

    // Dedupe covers the replay ring only. Older redeliveries can arrive in
    // this same process; do not claim durable or exactly-once delivery.
    const ring = this.#recent.get(print.marketId) ?? [];
    ring.push(print);
    while (ring.length > limit) {
      const dropped = ring.shift();
      if (dropped) seen.delete(dropped.sequence);
    }
    this.#recent.set(print.marketId, ring);

    this.#prints += 1;
    this.#fanOut(print);
    return print;
  }

  #hasWatcher(marketId: string): boolean {
    for (const s of this.#subscriptions) {
      if (!s.closed && s.marketId === marketId) return true;
    }
    return false;
  }

  /** Past connect flush. A pending subscriber is still waiting on replay. */
  #hasLiveWatcher(marketId: string): boolean {
    for (const s of this.#subscriptions) {
      if (!s.closed && !s.pending && s.marketId === marketId) return true;
    }
    return false;
  }

  #fanOut(print: StoredPrint): void {
    const frame = JSON.stringify(print);

    for (const sub of [...this.#subscriptions]) {
      if (sub.closed || sub.marketId !== print.marketId) continue;

      // Still replaying history — live prints land in the ring and are
      // included when flush runs, so do not double-send.
      if (sub.pending) continue;

      if (isPublishedHighWaterBytes(this.#options.highWaterBytes) && sub.sink.bufferedBytes > this.#options.highWaterBytes) {
        sub.lagTicks += 1;
        this.#droppedFrames += 1;
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
      this.#write(sub, frame);
    }
  }

  #write(sub: Subscription, frame: string): void {
    if (isLiveZeroTapeFrame(frame)) {
      this.#log.warn({ marketId: sub.marketId }, 'ws: refused live-zero tape frame');
      return;
    }
    try {
      sub.sink.send(frame);
    } catch (err) {
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
    this.#forgetIdleMarket(sub.marketId);
  }

  closeAll(code: number, reason: string): void {
    for (const sub of [...this.#subscriptions]) this.#evict(sub, code, reason);
  }
}
