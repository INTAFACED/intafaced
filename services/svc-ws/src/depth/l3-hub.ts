import { resolveWsCopy, WS_COPY } from '../copy.js';
import { isPublishedDepthLimit, nativeL3HasRestingDepth, windowNativeL3Queue } from '../depth-limit.js';
import { isPublishedHighWaterBytes } from '../high-water-bytes.js';
import { isPublishedConnectionCeiling } from '../max-connections.js';
import { isPublishedMaxLagTicks } from '../max-lag-ticks.js';
import { DEPTH_L3_UNAVAILABLE, DEPTH_TRANSPORT_POLL } from '../gateway-policy.js';
import {
  CLOSE_GOING_AWAY,
  CLOSE_POLICY,
  CLOSE_TRY_LATER,
  depthEngineUnavailableFrame,
  DEPTH_ENGINE_UNAVAILABLE,
  type DepthSink,
  type HubLogger,
} from './hub.js';
import { DepthL3UnavailableError, DepthNoBookError, DepthSourceError, type DepthSource, type NativeL3Queue } from './source.js';

/**
 * Native L3 fan-out. Polls matching `GET /markets/:id/depth/l3` only.
 * Never reads L2 `snapshot()` / never copies [price, size] tuples.
 * Frames name `transport: poll` — this is not an engine push feed.
 */

export type NativeL3Sink = DepthSink;

export type NativeL3Probe = 'ok' | 'unavailable' | 'nobook' | 'engine' | 'unknown';

export interface NativeL3Frame extends NativeL3Queue {
  readonly type: 'snapshot';
  readonly transport: typeof DEPTH_TRANSPORT_POLL;
}

export interface NativeL3UnavailableFrame {
  readonly type: 'status';
  readonly code: typeof DEPTH_L3_UNAVAILABLE;
  readonly marketId: string;
}

/**
 * A successful queue with nothing resting. Engine and L3 are up.
 * Not `depth.l3_unavailable`, not `depth.engine_unavailable`, and not a
 * snapshot — a snapshot with empty bids and asks would be a live zero book.
 */
export const DEPTH_L3_NO_RESTING = 'depth.l3_no_resting' as const;

export interface NativeL3NoRestingFrame {
  readonly type: 'status';
  readonly code: typeof DEPTH_L3_NO_RESTING;
  readonly marketId: string;
}

export function nativeL3Frame(queue: NativeL3Queue): string {
  const frame: NativeL3Frame = { ...queue, type: 'snapshot', transport: DEPTH_TRANSPORT_POLL };
  return JSON.stringify(frame);
}

export function nativeL3UnavailableFrame(marketId: string): string {
  const frame: NativeL3UnavailableFrame = { type: 'status', code: DEPTH_L3_UNAVAILABLE, marketId };
  return JSON.stringify(frame);
}

export function nativeL3NoRestingFrame(marketId: string): string {
  const frame: NativeL3NoRestingFrame = { type: 'status', code: DEPTH_L3_NO_RESTING, marketId };
  return JSON.stringify(frame);
}

export interface NativeL3HubOptions {
  /** Owner-published L3 price-level window. Unset = unpublished; attach refuses. Never invent 20/50. */
  readonly depthLimit: number | undefined;
  /** Owner-published lag buffer bound. Unset = unpublished; attach refuses. Never invent 1048576. */
  readonly highWaterBytes: number | undefined;
  /** Owner-published lag ticks. Unset = unpublished; attach refuses. Never invent 20. */
  readonly maxLagTicks: number | undefined;
  readonly maxConnections: number | undefined;
  readonly ensureKnownMarket: (marketId: string) => Promise<boolean>;
}

interface Subscription {
  readonly marketId: string;
  readonly sink: NativeL3Sink;
  lagTicks: number;
  closed: boolean;
}

const NO_LOG: HubLogger = { info: () => undefined, warn: () => undefined };

export class NativeL3Hub {
  readonly #source: DepthSource;
  readonly #options: NativeL3HubOptions;
  readonly #log: HubLogger;
  readonly #subscriptions = new Set<Subscription>();
  readonly #last = new Map<string, string>();
  readonly #l3Down = new Set<string>();
  readonly #engineDown = new Set<string>();

  constructor(source: DepthSource, options: NativeL3HubOptions, log: HubLogger = NO_LOG) {
    this.#source = source;
    this.#options = options;
    this.#log = log;
  }

  get connections(): number {
    return this.#subscriptions.size;
  }

  get maxConnections(): number | undefined {
    return this.#options.maxConnections;
  }

  get activeMarkets(): string[] {
    const active = new Set<string>();
    for (const sub of this.#subscriptions) if (!sub.closed) active.add(sub.marketId);
    return [...active];
  }

  get stats(): { connections: number; code: typeof DEPTH_L3_UNAVAILABLE | typeof DEPTH_ENGINE_UNAVAILABLE | null } {
    return {
      connections: this.#subscriptions.size,
      code: this.#l3Down.size > 0 ? DEPTH_L3_UNAVAILABLE : this.#engineDown.size > 0 ? DEPTH_ENGINE_UNAVAILABLE : null,
    };
  }

  /**
   * Upgrade-time classification. `unavailable` must 409 before a socket so L2
   * is never attached. `unknown` still upgrades (typed close, same as L2).
   */
  async probe(marketId: string): Promise<NativeL3Probe> {
    if (typeof this.#source.l3Queue !== 'function') return 'unavailable';
    if (!(await this.#options.ensureKnownMarket(marketId))) return 'unknown';
    try {
      const limit = this.#options.depthLimit;
      if (!isPublishedDepthLimit(limit)) {
        this.#last.delete(marketId);
        return 'ok';
      }
      const queue = await this.#source.l3Queue(marketId, limit);
      this.#l3Down.delete(marketId);
      this.#engineDown.delete(marketId);
      const windowed = this.#windowed(queue);
      if (windowed === 'unpublished') {
        this.#last.delete(marketId);
        return 'ok';
      }
      if (windowed === 'empty') {
        this.#last.delete(marketId);
        return 'nobook';
      }
      this.#remember(windowed);
      return 'ok';
    } catch (err) {
      if (err instanceof DepthL3UnavailableError) {
        this.#last.delete(marketId);
        this.#l3Down.add(marketId);
        return 'unavailable';
      }
      if (err instanceof DepthNoBookError) {
        this.#last.delete(marketId);
        this.#engineDown.delete(marketId);
        this.#l3Down.delete(marketId);
        return 'nobook';
      }
      this.#engineDown.add(marketId);
      this.#log.warn({ marketId, err: String(err) }, 'ws: native L3 probe failed');
      return 'engine';
    }
  }

  attach(marketId: string, sink: NativeL3Sink): (() => void) | null {
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
    const max = this.#options.maxConnections;
    if (!isPublishedConnectionCeiling(max)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.maxConnectionsUnset));
      return null;
    }
    if (this.#subscriptions.size >= max) {
      sink.close(CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.atCapacity));
      return null;
    }
    const sub: Subscription = { marketId, sink, lagTicks: 0, closed: false };
    this.#subscriptions.add(sub);
    void this.#open(sub);
    return () => {
      sub.closed = true;
      this.#subscriptions.delete(sub);
      this.#forgetIdle(marketId);
    };
  }

  ingest(queue: NativeL3Queue): void {
    if (queue.level !== 'L3') return;
    const windowed = this.#windowed(queue);
    if (windowed === 'unpublished') return;
    if (windowed === 'empty') {
      // Live subscribers still hold the last resting snapshot. Tell them the
      // book drained, then forget it so a new subscriber still sees absence.
      const hadResting = this.#last.has(queue.marketId);
      this.noteNoBook(queue.marketId);
      if (hadResting) this.#fanout(queue.marketId, nativeL3NoRestingFrame(queue.marketId));
      return;
    }
    const recovering = this.#engineDown.delete(windowed.marketId);
    this.#l3Down.delete(windowed.marketId);
    const frame = nativeL3Frame(windowed);
    // markEngineUnavailable keeps #last. An unchanged queue still has to
    // replace the down frame the live subscriber is holding.
    if (!recovering && this.#last.get(windowed.marketId) === frame) return;
    this.#last.set(windowed.marketId, frame);
    this.#fanout(windowed.marketId, frame);
  }

  markL3Unavailable(marketId: string): void {
    this.#l3Down.add(marketId);
    this.#last.delete(marketId);
    this.#fanout(marketId, nativeL3UnavailableFrame(marketId));
  }

  markEngineUnavailable(marketId: string): void {
    this.#engineDown.add(marketId);
    this.#fanout(marketId, depthEngineUnavailableFrame(marketId));
  }

  noteNoBook(marketId: string): void {
    this.#engineDown.delete(marketId);
    this.#l3Down.delete(marketId);
    this.#last.delete(marketId);
  }

  closeAll(code: number = CLOSE_GOING_AWAY, reason: string): void {
    for (const sub of [...this.#subscriptions]) this.#evict(sub, code, reason);
  }

  async tick(): Promise<void> {
    const markets = this.activeMarkets;
    if (markets.length === 0) return;
    if (typeof this.#source.l3Queue !== 'function') {
      for (const marketId of markets) this.markL3Unavailable(marketId);
      return;
    }
    const limit = this.#options.depthLimit;
    if (!isPublishedDepthLimit(limit)) return;
    await Promise.all(
      markets.map(async (marketId) => {
        try {
          const queue = await this.#source.l3Queue!(marketId, limit);
          this.ingest(queue);
        } catch (err) {
          if (err instanceof DepthL3UnavailableError) this.markL3Unavailable(marketId);
          else if (err instanceof DepthNoBookError) this.noteNoBook(marketId);
          else this.markEngineUnavailable(marketId);
          this.#log.warn({ marketId, err: String(err) }, 'ws: native L3 poll failed');
        }
      }),
    );
  }

  async #open(sub: Subscription): Promise<void> {
    try {
      if (!(await this.#options.ensureKnownMarket(sub.marketId))) {
        this.#evict(sub, CLOSE_POLICY, resolveWsCopy(WS_COPY.unknownMarket));
        return;
      }
      if (sub.closed) return;
      if (this.#l3Down.has(sub.marketId)) {
        this.#write(sub, nativeL3UnavailableFrame(sub.marketId));
        return;
      }
      if (this.#engineDown.has(sub.marketId)) {
        this.#write(sub, depthEngineUnavailableFrame(sub.marketId));
        return;
      }
      const cached = this.#last.get(sub.marketId);
      if (cached) this.#write(sub, cached);
    } catch (err) {
      this.#evict(sub, CLOSE_TRY_LATER, err instanceof DepthSourceError ? err.message : 'l3 unavailable');
    }
  }

  #windowed(queue: NativeL3Queue): NativeL3Queue | 'unpublished' | 'empty' {
    const limit = this.#options.depthLimit;
    if (!isPublishedDepthLimit(limit)) return 'unpublished';
    const windowed = windowNativeL3Queue(queue, limit);
    if (!nativeL3HasRestingDepth(windowed)) return 'empty';
    return windowed;
  }

  #remember(queue: NativeL3Queue): void {
    this.#last.set(queue.marketId, nativeL3Frame(queue));
  }

  #forgetIdle(marketId: string): void {
    for (const sub of this.#subscriptions) if (sub.marketId === marketId && !sub.closed) return;
    this.#last.delete(marketId);
  }

  #fanout(marketId: string, frame: string): void {
    for (const sub of this.#subscriptions) {
      if (sub.closed || sub.marketId !== marketId) continue;
      this.#write(sub, frame);
    }
  }

  #write(sub: Subscription, frame: string): void {
    if (sub.closed) return;
    if (isPublishedHighWaterBytes(this.#options.highWaterBytes) && sub.sink.bufferedBytes > this.#options.highWaterBytes) {
      sub.lagTicks += 1;
      if (isPublishedMaxLagTicks(this.#options.maxLagTicks) && sub.lagTicks >= this.#options.maxLagTicks) {
        this.#evict(sub, CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.atCapacity));
      }
      return;
    }
    sub.lagTicks = 0;
    try {
      sub.sink.send(frame);
    } catch {
      this.#evict(sub, CLOSE_GOING_AWAY, resolveWsCopy(WS_COPY.shuttingDown));
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
    this.#forgetIdle(sub.marketId);
  }
}
