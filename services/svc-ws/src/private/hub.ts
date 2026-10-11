import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_POLICY, CLOSE_TRY_LATER, type DepthSink, type HubLogger } from '../depth/hub.js';
import { isPublishedHighWaterBytes } from '../high-water-bytes.js';
import { isPublishedConnectionCeiling } from '../max-connections.js';
import { isPublishedMaxLagTicks } from '../max-lag-ticks.js';
import { ORDERS_ENGINE_UNAVAILABLE } from '../gateway-policy.js';
import {
  ORDERS_MARKET_HALTED,
  ORDERS_VENUE_HALTED,
  ordersCodeForDepth,
  ordersMatchingTradingFrame,
  ordersSubmitsResumedFrame,
  type DepthMatchingTradingCode,
  type OrdersMatchingTradingCode,
} from '../matching-trading.js';
import { encodePrivateFillFrame, encodePrivateOrderFrame } from './order-facts.js';
import { encodePrivatePositionFrame, encodePrivatePositionsSnapshotFrame } from './private-positions-payload-freeze.js';

export { ORDERS_ENGINE_UNAVAILABLE };

/**
 * PRIVATE ORDER / FILL / POSITION FAN-OUT.
 *
 * Fans trade-owned lifecycle frames to sockets authenticated as that user only.
 * This hub never places orders, never opens positions, and never holds balances —
 * it is a mirror of events for clients that already know the user.
 *
 * ── Empty ≠ zero ────────────────────────────────────────────────────────────
 *
 * An unseeded blotter, a matching 404, or a no-blotter seed is **absence**.
 * Emitting `{ orders: [] }` / `{ positions: [] }` (or a JSON `[]`) would let a
 * client treat that as a live zero book of nothing. Listed seats stay
 * subscribed with no blotter frames until a real order or position exists.
 * Matching-down is **named** (`orders.engine_unavailable`) — never a blank
 * blotter that looks like a quiet book. Fills are never invented. Ready frames
 * (`type: "ready"`) are honesty about the bus. A `type: "snapshot"` hydrate
 * (including `orders: []`) is a reconnect book, not a live-zero delta — empty
 * list is honest empty, not omitted, and is skipped when the engine is down.
 */

export type PrivateSink = DepthSink;

/** Private socket catalog. Omit on attach = all three (back-compat). */
export type PrivateStreamChannel = 'orders' | 'fills' | 'positions';

export interface PrivateOrderUpdate {
  readonly orderId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly status: string;
  readonly side: string;
  readonly type: string;
  readonly qty: string;
  readonly filledQty: string;
  readonly price: string | null;
  readonly clientOrderId: string | null;
  readonly ts: string;
}

export interface PrivateFillUpdate {
  readonly fillId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly side: string;
  readonly liquidity: string;
  readonly price: string;
  readonly qty: string;
  readonly quoteAmount: string;
  readonly feeAsset: string;
  readonly feeAmount: string;
  readonly feeBps: number;
  readonly sequence: number;
  readonly ts: string;
}

export interface PrivatePositionUpdate {
  readonly positionId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly symbol: string;
  /** Includes `closing` — voluntary exit waiting on a mark (ADR 2026-08-07). */
  readonly status: 'open' | 'closing' | 'closed' | 'liquidated';
  readonly side: 'long' | 'short';
  readonly contracts: string;
  readonly entryPrice: string;
  readonly markPrice: string | null;
  readonly notional: string;
  readonly leverage: string | null;
  readonly collateral: string | null;
  readonly unrealizedPnl: string | null;
  readonly realizedPnl: string | null;
  readonly liquidationPrice: string | null;
  readonly marginMode: 'cross' | 'isolated' | null;
  readonly fundingPaid: string | null;
  readonly closingReason?: string | null;
  readonly ts: string;
}

export interface PrivateOrderHubOptions {
  /** Owner-published lag buffer bound. Unset = unpublished; attach refuses. Never invent 1048576. */
  readonly highWaterBytes: number | undefined;
  /** Owner-published lag ticks. Unset = unpublished; attach refuses. Never invent 20. */
  readonly maxLagTicks: number | undefined;
  readonly maxConnections: number | undefined;
  /**
   * Owner-published ceiling per principal so one user cannot fill the replica
   * pool. Blank / omitted is unpublished — attach refuses
   * `ws.private_max_connections_per_user_unset`. Never invent 16.
   */
  readonly maxConnectionsPerUser?: number;
  /**
   * Optional cold-start fetch (tests / future matching blotter). Empty or throw
   * is absence — never flushed as `{ orders: [] }`. Fills are never seeded.
   */
  readonly seedOrders?: (userId: string) => Promise<readonly PrivateOrderUpdate[]>;
  /**
   * Optional cold-start fetch for positions. Empty or throw is absence — never
   * flushed as `{ positions: [] }`.
   */
  readonly seedPositions?: (userId: string) => Promise<readonly PrivatePositionUpdate[]>;
}

/**
 * `{ orders: [] }` / `{ positions: [] }` / `{ fills: [] }` / JSON `[]` on the
 * wire is a priced empty blotter. Empty is absent: no frame, not a live zero
 * book of nothing. Ready frames are not a snapshot.
 */
export function isLiveZeroBlotterPayload(value: unknown): boolean {
  if (Array.isArray(value) && value.length === 0) return true;
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  if (rec.type === 'ready' || rec.type === 'snapshot' || rec.type === 'status') return false;
  if (typeof rec.type === 'string' && rec.type.startsWith('cod.')) return false;
  for (const key of ['orders', 'positions', 'fills'] as const) {
    if (key in rec && Array.isArray(rec[key]) && rec[key].length === 0) return true;
  }
  return false;
}

export function isLiveZeroBlotterFrame(frame: string): boolean {
  try {
    return isLiveZeroBlotterPayload(JSON.parse(frame) as unknown);
  } catch {
    return false;
  }
}

/**
 * Matching 404 / no private blotter. Absence, not engine-down — callers must
 * not coerce it into `{ orders: [] }` or a status frame.
 */
export class PrivateNoBlotterError extends Error {
  constructor(readonly userId: string) {
    super(`${userId}: matching holds no blotter`);
    this.name = 'PrivateNoBlotterError';
  }
}

export interface PrivateEngineStatusFrame {
  readonly type: 'status';
  readonly code: typeof ORDERS_ENGINE_UNAVAILABLE;
  readonly channel: 'orders' | 'fills';
  readonly userId: string;
}

export function ordersEngineUnavailableFrame(userId: string, channel: 'orders' | 'fills' = 'orders'): string {
  const frame: PrivateEngineStatusFrame = { type: 'status', code: ORDERS_ENGINE_UNAVAILABLE, channel, userId };
  return JSON.stringify(frame);
}

interface Subscription {
  readonly userId: string;
  readonly sink: PrivateSink;
  /** `null` = every private channel (default attach). */
  readonly channel: PrivateStreamChannel | null;
  lagTicks: number;
  closed: boolean;
  hydrated: boolean;
  pending: string[];
  /** Ids already sent live while this seat's cold seed is still in flight. */
  liveDuringSeed: { orders: Set<string>; positions: Set<string> } | null;
}

const NO_LOG: HubLogger = { info: () => undefined, warn: () => undefined };

const READY_CHANNELS = ['orders', 'fills', 'positions'] as const;

export class PrivateOrderHub {
  readonly #options: PrivateOrderHubOptions;
  readonly #log: HubLogger;
  readonly #subscriptions = new Set<Subscription>();
  #droppedFrames = 0;
  #evictions = 0;
  #updates = 0;
  /** Matching-down (process-wide). Distinct from a 404 / empty blotter. */
  #engineUnavailable = false;
  /** Matching-up, not taking submits. '*' = venue halt-all. */
  readonly #trading = new Map<string, OrdersMatchingTradingCode>();

  constructor(options: PrivateOrderHubOptions, log: HubLogger = NO_LOG) {
    this.#options = options;
    this.#log = log;
  }

  get connections(): number {
    return this.#subscriptions.size;
  }

  /** Per-hub seat ceiling (same bound attach enforces). Not process-wide. Unset = unpublished. */
  get maxConnections(): number | undefined {
    return this.#options.maxConnections;
  }

  /** Per-principal cap on the private hub. Unset = unpublished (never invent 16). */
  get maxConnectionsPerUser(): number | undefined {
    return this.#options.maxConnectionsPerUser;
  }

  get matchingAvailable(): boolean {
    return !this.#engineUnavailable;
  }

  get engineCode(): typeof ORDERS_ENGINE_UNAVAILABLE | null {
    return this.#engineUnavailable ? ORDERS_ENGINE_UNAVAILABLE : null;
  }

  get isEngineUnavailable(): boolean {
    return this.#engineUnavailable;
  }

  get stats(): {
    connections: number;
    updates: number;
    droppedFrames: number;
    evictions: number;
    matchingAvailable: boolean;
    code: typeof ORDERS_ENGINE_UNAVAILABLE | null;
  } {
    return {
      connections: this.#subscriptions.size,
      updates: this.#updates,
      droppedFrames: this.#droppedFrames,
      evictions: this.#evictions,
      matchingAvailable: this.matchingAvailable,
      code: this.engineCode,
    };
  }

  /**
   * Register a sink for `userId`. Returns a detach function, or `null` when the
   * hub is at capacity (sink is closed with 1013 before return). Callers must
   * not send ready frames after a null — that would claim a subscription the
   * hub never held.
   *
   * `channel` is an optional fan-out filter. Omitted / null still delivers all
   * three private channels; owner isolation is unchanged.
   */
  attach(
    userId: string,
    sink: PrivateSink,
    channel: PrivateStreamChannel | null = null,
    options: { holdUntilSnapshot?: boolean } = {},
  ): (() => void) | null {
    if (!isPublishedHighWaterBytes(this.#options.highWaterBytes)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.highWaterBytesUnset));
      return null;
    }
    if (!isPublishedMaxLagTicks(this.#options.maxLagTicks)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.maxLagTicksUnset));
      return null;
    }
    const max = this.#options.maxConnections;
    if (!isPublishedConnectionCeiling(max)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.maxConnectionsUnset));
      return null;
    }
    if (this.#subscriptions.size >= max) {
      sink.close(CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.privateAtCapacity));
      return null;
    }

    const maxPerUser = this.#options.maxConnectionsPerUser;
    if (!isPublishedConnectionCeiling(maxPerUser)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.privateMaxConnectionsPerUserUnset));
      return null;
    }
    let forUser = 0;
    for (const existing of this.#subscriptions) {
      if (!existing.closed && existing.userId === userId) forUser++;
    }
    if (forUser >= maxPerUser) {
      sink.close(CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.privateUserLimit));
      return null;
    }

    const sub: Subscription = {
      userId,
      sink,
      channel,
      lagTicks: 0,
      closed: false,
      hydrated: options.holdUntilSnapshot !== true,
      pending: [],
      liveDuringSeed: null,
    };
    this.#subscriptions.add(sub);
    if (this.#engineUnavailable) this.#queueOrWriteUnavailable(sub);
    else this.#queueOrWriteTrading(sub);
    if (this.#options.seedOrders || this.#options.seedPositions) {
      void this.#seed(sub);
    }
    return () => {
      sub.closed = true;
      this.#subscriptions.delete(sub);
    };
  }

  /** Flush live frames that arrived while the reconnect snapshot was in flight. */
  releaseSnapshot(sink: PrivateSink): void {
    for (const sub of this.#subscriptions) {
      if (sub.closed || sub.sink !== sink) continue;
      sub.hydrated = true;
      const queued = sub.pending;
      sub.pending = [];
      for (const frame of queued) this.#write(sub, frame);
      return;
    }
  }

  sendOrdersSnapshot(sink: PrivateSink, userId: string, orders: readonly PrivateOrderUpdate[]): void {
    this.#snapshot(sink, JSON.stringify({ channel: 'orders', type: 'snapshot', userId, orders }));
  }

  sendPositionsSnapshot(sink: PrivateSink, userId: string, positions: readonly PrivatePositionUpdate[]): void {
    this.#snapshot(sink, encodePrivatePositionsSnapshotFrame(userId, positions));
  }

  #snapshot(sink: PrivateSink, frame: string): void {
    for (const sub of this.#subscriptions) {
      if (sub.closed || sub.sink !== sink) continue;
      this.#write(sub, frame);
      return;
    }
  }

  /**
   * Matching 404 / empty / throw is absence. Replay real rows only — never
   * `{ orders: [] }` or `{ positions: [] }`. Fills are never seeded.
   */
  async #seed(sub: Subscription): Promise<void> {
    // A live row that leaves during an await is newer than this cold fetch.
    const live = { orders: new Set<string>(), positions: new Set<string>() };
    sub.liveDuringSeed = live;
    try {
      if (this.#options.seedOrders) {
        try {
          const orders = await this.#options.seedOrders(sub.userId);
          if (orders.length === 0) {
            this.#log.warn(
              { userId: sub.userId },
              'ws-private: order seed empty — no blotter on the wire; live orders publish when they exist',
            );
          } else {
            for (const order of orders) {
              if (sub.closed) return;
              if (live.orders.has(order.orderId)) {
                this.#log.warn(
                  { userId: sub.userId, orderId: order.orderId },
                  'ws-private: order seed older than a live publish during the seed await — skipped',
                );
                continue;
              }
              this.#write(sub, encodePrivateOrderFrame(order));
            }
          }
        } catch (err) {
          if (err instanceof PrivateNoBlotterError) {
            this.#log.warn(
              { userId: sub.userId, err: err.message },
              'ws-private: order seed — matching holds no blotter (absence, not engine-down)',
            );
          } else {
            this.markEngineUnavailable();
            this.#log.warn(
              { userId: sub.userId, err: err instanceof Error ? err.message : String(err) },
              'ws-private: order seed failed — disclosing orders.engine_unavailable; matching 404 is absence not { orders: [] }',
            );
          }
        }
      }
      if (sub.closed) return;
      if (this.#options.seedPositions) {
        try {
          const positions = await this.#options.seedPositions(sub.userId);
          if (positions.length === 0) {
            this.#log.warn(
              { userId: sub.userId },
              'ws-private: position seed empty — no blotter on the wire; live positions publish when they exist',
            );
          } else {
            for (const position of positions) {
              if (sub.closed) return;
              if (live.positions.has(position.positionId)) {
                this.#log.warn(
                  { userId: sub.userId, positionId: position.positionId },
                  'ws-private: position seed older than a live publish during the seed await — skipped',
                );
                continue;
              }
              this.#write(sub, encodePrivatePositionFrame(position));
            }
          }
        } catch (err) {
          this.#log.warn(
            { userId: sub.userId, err: err instanceof Error ? err.message : String(err) },
            'ws-private: position seed failed — no blotter on the wire; matching 404 is absence not { positions: [] }',
          );
        }
      }
    } finally {
      if (sub.liveDuringSeed === live) sub.liveDuringSeed = null;
    }
  }

  /**
   * Re-announce channel ready + bus honesty to every live seat.
   * Used when the private half attaches after sockets already connected
   * with `bus: false` (boot tape-up / private-down). Does not invent
   * order/fill/position frames.
   */
  announceBus(bus: boolean): void {
    for (const sub of this.#subscriptions) {
      if (sub.closed) continue;
      const channels = sub.channel === null ? READY_CHANNELS : [sub.channel];
      for (const channel of channels) {
        this.#write(sub, JSON.stringify({ channel, type: 'ready', userId: sub.userId, bus }));
      }
    }
  }

  /**
   * Matching is down. Named disclosure once per down-edge so a private seat
   * cannot read silence as a blank blotter. Positions-only seats skip — they
   * are not the matching orders book.
   */
  markEngineUnavailable(): void {
    const first = !this.#engineUnavailable;
    this.#engineUnavailable = true;
    if (!first) return;
    for (const sub of this.#subscriptions) {
      if (sub.closed) continue;
      this.#queueOrWriteUnavailable(sub);
    }
  }

  /** Matching answered again. Status is not retracted; live order frames resume. */
  noteEngineUp(): void {
    this.#engineUnavailable = false;
  }

  /**
   * Matching is up and this market (or the venue) is not taking submits.
   * Named so a blotter cannot be read as tradable. Cancels still flow.
   * `marketId` `*` is venue halt-all. Null clears that name. A cleared market
   * or venue halt tells seats that already have it that submits resumed.
   * Not a price and not an invented OPEN. Prelaunch, expire, and delist are
   * not that door.
   */
  noteMatchingTrading(marketId: string, depthCode: DepthMatchingTradingCode | null): void {
    const key = marketId;
    if (depthCode === null) {
      const prev = this.#trading.get(key);
      if (prev === undefined) return;
      this.#trading.delete(key);
      if (prev === ORDERS_MARKET_HALTED || prev === ORDERS_VENUE_HALTED) {
        const resumedMarketId = prev === ORDERS_VENUE_HALTED || key === '*' ? undefined : key;
        for (const sub of this.#subscriptions) {
          if (sub.closed) continue;
          this.#queueOrWriteSubmitsResumed(sub, resumedMarketId);
        }
      }
      return;
    }
    const code = ordersCodeForDepth(depthCode);
    if (this.#trading.get(key) === code) return;
    this.#trading.set(key, code);
    for (const sub of this.#subscriptions) {
      if (sub.closed) continue;
      this.#queueOrWriteTradingFrame(sub, code, key === '*' ? undefined : key);
    }
  }

  #queueOrWriteTrading(sub: Subscription): void {
    for (const [marketId, code] of this.#trading) {
      this.#queueOrWriteTradingFrame(sub, code, marketId === '*' ? undefined : marketId);
    }
  }

  #queueOrWriteTradingFrame(sub: Subscription, code: OrdersMatchingTradingCode, marketId: string | undefined): void {
    if (sub.channel === 'positions') return;
    const channel = sub.channel === 'fills' ? 'fills' : 'orders';
    const frame = ordersMatchingTradingFrame(sub.userId, code, marketId, channel);
    if (!sub.hydrated) {
      sub.pending.push(frame);
      return;
    }
    this.#write(sub, frame);
  }

  #queueOrWriteSubmitsResumed(sub: Subscription, marketId: string | undefined): void {
    if (sub.channel === 'positions') return;
    const channel = sub.channel === 'fills' ? 'fills' : 'orders';
    const frame = ordersSubmitsResumedFrame(sub.userId, channel, marketId);
    if (!sub.hydrated) {
      sub.pending.push(frame);
      return;
    }
    this.#write(sub, frame);
  }

  #engineUnavailableFrame(sub: Subscription): string | null {
    if (sub.channel === 'positions') return null;
    const channel = sub.channel === 'fills' ? 'fills' : 'orders';
    return ordersEngineUnavailableFrame(sub.userId, channel);
  }

  #queueOrWriteUnavailable(sub: Subscription): void {
    const frame = this.#engineUnavailableFrame(sub);
    if (frame === null) return;
    if (!sub.hydrated) {
      sub.pending.push(frame);
      return;
    }
    this.#write(sub, frame);
  }

  publish(update: PrivateOrderUpdate): void {
    this.#fanout(update.userId, 'orders', encodePrivateOrderFrame(update), update.orderId);
  }

  publishFill(update: PrivateFillUpdate): void {
    this.#fanout(update.userId, 'fills', encodePrivateFillFrame(update), null);
  }

  publishPosition(update: PrivatePositionUpdate): void {
    // Freeze strips unknown keys (including a fabricated `positions: []`).
    // Refuse the live-zero blotter on the update, before encode, or honesty
    // tests and tip Tests(full) see a real-looking position frame.
    if (isLiveZeroBlotterPayload(update)) return;
    this.#fanout(update.userId, 'positions', encodePrivatePositionFrame(update), update.positionId);
  }

  /**
   * Socket bytes plus frames still held for hydration. A stuck open-orders
   * read never hands those frames to the kernel, so the socket mark alone
   * would let `pending` grow without the lag check.
   */
  #overHighWater(sub: Subscription): boolean {
    const limit = this.#options.highWaterBytes;
    if (!isPublishedHighWaterBytes(limit)) return false;
    let bytes = sub.sink.bufferedBytes;
    for (const frame of sub.pending) bytes += Buffer.byteLength(frame);
    return bytes > limit;
  }

  #fanout(userId: string, channel: PrivateStreamChannel, frame: string, liveId: string | null): void {
    this.#updates++;

    for (const sub of this.#subscriptions) {
      if (sub.closed || sub.userId !== userId) continue;
      if (sub.channel !== null && sub.channel !== channel) continue;
      if (this.#overHighWater(sub)) {
        this.#noteLag(sub);
        continue;
      }

      sub.lagTicks = 0;
      if (!sub.hydrated) {
        sub.pending.push(frame);
        continue;
      }
      if (this.#write(sub, frame)) this.#noteLiveDuringSeed(sub, channel, liveId);
    }
  }

  #noteLiveDuringSeed(sub: Subscription, channel: PrivateStreamChannel, liveId: string | null): void {
    const live = sub.liveDuringSeed;
    if (live === null || liveId === null) return;
    if (channel === 'orders') live.orders.add(liveId);
    else if (channel === 'positions') live.positions.add(liveId);
  }

  #write(sub: Subscription, frame: string): boolean {
    if (sub.closed) return false;
    if (isLiveZeroBlotterFrame(frame)) {
      this.#log.warn({ userId: sub.userId }, 'ws-private: refused live-zero blotter frame');
      return false;
    }
    try {
      sub.sink.send(frame);
      return true;
    } catch {
      sub.closed = true;
      this.#subscriptions.delete(sub);
      return false;
    }
  }

  /**
   * Quiet-period lag sweep. Publish-path lag only fires when events arrive for
   * that user — a slow socket that stops draining can pin a seat forever if
   * the market is quiet. Gateway heartbeat calls this so private matches depth:
   * lag over high-water for maxLagTicks → 1013, seat freed.
   */
  sweepLag(): void {
    for (const sub of [...this.#subscriptions]) {
      if (sub.closed) continue;
      if (this.#overHighWater(sub)) this.#noteLag(sub);
      else sub.lagTicks = 0;
    }
  }

  #noteLag(sub: Subscription): void {
    sub.lagTicks++;
    this.#droppedFrames++;
    if (!isPublishedMaxLagTicks(this.#options.maxLagTicks) || sub.lagTicks < this.#options.maxLagTicks) return;
    this.#evictions++;
    sub.closed = true;
    this.#subscriptions.delete(sub);
    // Align with depth/trade: lag is try-later (1013), not policy (1008).
    try {
      sub.sink.close(
        CLOSE_TRY_LATER,
        `slow consumer: outbound buffer over ${this.#options.highWaterBytes} bytes for ${sub.lagTicks} ticks`,
      );
    } catch {
      /* already gone */
    }
    this.#log.warn({ userId: sub.userId }, 'ws-private: evicted lagging client');
  }

  async close(reason: string): Promise<void> {
    for (const sub of [...this.#subscriptions]) {
      sub.closed = true;
      try {
        sub.sink.close(1001, reason);
      } catch {
        /* ignore */
      }
    }
    this.#subscriptions.clear();
  }
}
