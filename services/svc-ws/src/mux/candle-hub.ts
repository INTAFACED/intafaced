import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_POLICY, CLOSE_TRY_LATER, type DepthSink, type HubLogger } from '../depth/hub.js';
import { isPublishedHighWaterBytes } from '../high-water-bytes.js';
import { isPublishedConnectionCeiling } from '../max-connections.js';
import { isPublishedMaxLagTicks } from '../max-lag-ticks.js';
import { MUX_INTERVAL_MS, type MuxInterval } from './protocol.js';

/**
 * CANDLE FAN-OUT — the current candle, per market and interval.
 *
 * ── Where candles come from (and why this does not build its own) ───────────
 *
 * svc-trade already aggregates candles in SQL from the real taker-fill tape
 * (`GET /api/v1/ohlcv/:symbol`, the same rows the chart's history uses, with
 * seeded-order fills excluded). A second aggregator here, fed from the
 * `orderFilled` bus stream, would disagree with it: the bus carries fills that
 * touch seeded orders, so the live candle would not match the history it
 * continues, and a subscriber that joined mid-bucket would have a wrong `open`
 * (this service holds no fill history to rebuild it from). So `mux/poller.ts`
 * re-reads the newest two buckets of each WATCHED (market, interval) from that
 * endpoint and this hub fans out what changed.
 *
 * Every price in a candle is a price something really traded at. A bucket with
 * no fills is ABSENT — there is no zero-filled candle and no carry-forward.
 *
 * ── What a frame says ───────────────────────────────────────────────────────
 *
 * `t` is the bucket's OPEN time in ms (the CCXT / charting convention). `closed`
 * is true once the bucket's span has elapsed — the last frame for a bucket has
 * `closed: true`, so a client knows the value is final. A candle is state, not
 * an event: the newest frame for a `t` replaces the previous one, so a dropped
 * frame is repaired by the next frame or by `resync`.
 *
 * No timer, no I/O: the caller drives `ingest` with a clock.
 */

export const CANDLES_UNAVAILABLE = 'candles.unavailable' as const;

/** Amounts are decimal strings. */
export interface WireCandle {
  readonly t: number;
  readonly o: string;
  readonly h: string;
  readonly l: string;
  readonly c: string;
  readonly v: string;
}

interface CachedCandle extends WireCandle {
  readonly closed: boolean;
}

export interface CandleHubOptions {
  readonly highWaterBytes: number | undefined;
  readonly maxLagTicks: number | undefined;
  readonly maxConnections: number | undefined;
  /** Called (not awaited) when a subscriber arrives for a key with nothing cached. */
  readonly onDemand?: (marketId: string, interval: MuxInterval) => void;
  /**
   * How long a key with no subscriber keeps its last read, in ms. Production
   * passes `WS_CANDLE_POLL_MS`. Unpublished drops the cache the moment the
   * last subscriber leaves.
   */
  readonly retainMs?: number;
}

interface Subscription {
  readonly marketId: string;
  readonly interval: MuxInterval;
  readonly sink: DepthSink;
  lagTicks: number;
  lagging: boolean;
  closed: boolean;
}

const NO_LOG: HubLogger = { info: () => undefined, warn: () => undefined };

/** The newest candles kept per key: the open bucket and the one before it (so a rollover can finalise it). */
const KEEP = 2;

function keyOf(marketId: string, interval: MuxInterval): string {
  return `${marketId}|${interval}`;
}

function isPublishedRetain(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function sameCandle(a: CachedCandle | undefined, b: CachedCandle): boolean {
  return a !== undefined && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v && a.closed === b.closed;
}

export class CandleHub {
  readonly #options: CandleHubOptions;
  readonly #log: HubLogger;
  readonly #subscriptions = new Set<Subscription>();
  /** Per key, ascending by `t`, at most `KEEP`. */
  readonly #cache = new Map<string, CachedCandle[]>();
  readonly #unavailable = new Set<string>();
  /** When the last subscriber left, for keys still inside `retainMs`. */
  readonly #idleAt = new Map<string, number>();
  #lastNow = 0;
  #droppedFrames = 0;
  #evictions = 0;
  #repairs = 0;
  #frames = 0;

  constructor(options: CandleHubOptions, log: HubLogger = NO_LOG) {
    this.#options = options;
    this.#log = log;
  }

  get connections(): number {
    return this.#subscriptions.size;
  }

  get maxConnections(): number | undefined {
    return this.#options.maxConnections;
  }

  get stats(): { connections: number; keys: number; frames: number; droppedFrames: number; evictions: number; repairs: number } {
    return {
      connections: this.#subscriptions.size,
      keys: this.activeKeys.length,
      frames: this.#frames,
      droppedFrames: this.#droppedFrames,
      evictions: this.#evictions,
      repairs: this.#repairs,
    };
  }

  /** (market, interval) pairs with at least one subscriber — exactly what the poller should read. */
  get activeKeys(): { marketId: string; interval: MuxInterval }[] {
    const seen = new Map<string, { marketId: string; interval: MuxInterval }>();
    for (const sub of this.#subscriptions) {
      if (!sub.closed) seen.set(keyOf(sub.marketId, sub.interval), { marketId: sub.marketId, interval: sub.interval });
    }
    return [...seen.values()];
  }

  /** Drop idle keys whose poll window has elapsed. The poller calls this on each sweep. */
  sweepIdle(now: number): void {
    this.#noteNow(now);
  }

  attach(marketId: string, interval: MuxInterval, sink: DepthSink, now: number = Date.now()): (() => void) | null {
    this.#noteNow(now);
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
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.muxMaxSeatsUnset));
      return null;
    }
    if (this.#subscriptions.size >= max) {
      sink.close(CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.atCapacity));
      return null;
    }

    const sub: Subscription = { marketId, interval, sink, lagTicks: 0, lagging: false, closed: false };
    this.#subscriptions.add(sub);

    const key = keyOf(marketId, interval);
    this.#idleAt.delete(key);
    if (this.#unavailable.has(key)) this.#write(sub, statusFrame(marketId, interval));
    else if (!this.#sendState(sub, now)) this.#options.onDemand?.(marketId, interval);

    return () => {
      sub.closed = true;
      this.#subscriptions.delete(sub);
      this.#forgetIdleKey(marketId, interval);
    };
  }

  /** Client-requested repair: the cached candles for this key, once. */
  resync(sink: DepthSink, now: number = Date.now()): 'sent' | 'deferred' | 'absent' | 'not_subscribed' {
    this.#noteNow(now);
    const sub = [...this.#subscriptions].find((s) => s.sink === sink && !s.closed);
    if (!sub) return 'not_subscribed';
    if (this.#unavailable.has(keyOf(sub.marketId, sub.interval))) {
      this.#write(sub, statusFrame(sub.marketId, sub.interval));
      return 'sent';
    }
    if (this.#overHighWater(sub)) {
      sub.lagging = true;
      return 'deferred';
    }
    if (!this.#sendState(sub, now)) return 'absent';
    this.#repairs += 1;
    return 'sent';
  }

  /**
   * The newest candles the source returned for a key (any order). Only a candle
   * that is new or changed is sent; a bucket that has now elapsed is sent once
   * more with `closed: true`.
   */
  ingest(marketId: string, interval: MuxInterval, candles: readonly WireCandle[], now: number): void {
    const key = keyOf(marketId, interval);
    const idle = this.#idleAt.has(key);
    this.#noteNow(now);
    const watching = this.#hasSubscriber(marketId, interval);
    if (!watching && !idle) return;
    const wasUnavailable = this.#unavailable.delete(key);

    const span = MUX_INTERVAL_MS[interval];
    const byT = new Map<number, CachedCandle>();
    const changed = new Map<number, CachedCandle>();
    // A bucket whose span has elapsed is final even if the source returned nothing new for it.
    for (const old of this.#cache.get(key) ?? []) {
      const closed = old.t + span <= now;
      const next = closed === old.closed ? old : { ...old, closed };
      byT.set(next.t, next);
      if (next !== old) changed.set(next.t, next);
    }
    const lastSeen = new Map<number, CachedCandle>((this.#cache.get(key) ?? []).map((c) => [c.t, c]));
    for (const candle of [...candles].sort((a, b) => a.t - b.t)) {
      const next: CachedCandle = { ...candle, closed: candle.t + span <= now };
      // Compare with what subscribers last saw.
      if (sameCandle(lastSeen.get(next.t), next)) changed.delete(next.t);
      else changed.set(next.t, next);
      byT.set(next.t, next);
    }
    const kept = [...byT.values()].sort((a, b) => a.t - b.t).slice(-KEEP);
    if (kept.length === 0) return;
    this.#cache.set(key, kept);
    if (!watching) {
      if (isPublishedRetain(this.#options.retainMs)) this.#idleAt.set(key, now);
      return;
    }

    const live = [...changed.values()].filter((c) => kept.some((k) => k.t === c.t)).sort((a, b) => a.t - b.t);
    for (const sub of [...this.#subscriptions]) {
      if (sub.closed || sub.marketId !== marketId || sub.interval !== interval) continue;
      if (wasUnavailable) {
        this.#sendState(sub, now);
        continue;
      }
      if (this.#overHighWater(sub)) {
        sub.lagging = true;
        sub.lagTicks += 1;
        if (live.length > 0) this.#droppedFrames += 1;
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
      if (sub.lagging) {
        sub.lagging = false;
        this.#repairs += 1;
        this.#sendState(sub, now);
        continue;
      }
      for (const candle of live) this.#write(sub, candleFrame(marketId, interval, candle));
    }
  }

  /** The source could not be read for this key. Named once per down-edge. */
  markUnavailable(marketId: string, interval: MuxInterval): void {
    const key = keyOf(marketId, interval);
    if (this.#unavailable.has(key)) return;
    const watching = this.#hasSubscriber(marketId, interval);
    if (!watching && !this.#idleAt.has(key)) return;
    this.#unavailable.add(key);
    this.#cache.delete(key);
    if (!watching) return;
    const frame = statusFrame(marketId, interval);
    for (const sub of [...this.#subscriptions]) {
      if (!sub.closed && sub.marketId === marketId && sub.interval === interval) this.#write(sub, frame);
    }
  }

  closeAll(code: number, reason: string): void {
    for (const sub of [...this.#subscriptions]) this.#evict(sub, code, reason);
    this.#cache.clear();
    this.#unavailable.clear();
    this.#idleAt.clear();
  }

  #hasSubscriber(marketId: string, interval: MuxInterval): boolean {
    for (const sub of this.#subscriptions) {
      if (!sub.closed && sub.marketId === marketId && sub.interval === interval) return true;
    }
    return false;
  }

  /**
   * Nobody is watching. Keep the last read for one poll window so a resubscribe
   * does not hit svc-trade again. After the window, or when no window was
   * published, drop it so a late subscriber is not handed a stale candle.
   */
  #forgetIdleKey(marketId: string, interval: MuxInterval): void {
    const key = keyOf(marketId, interval);
    if (this.#hasSubscriber(marketId, interval)) {
      this.#idleAt.delete(key);
      return;
    }
    if (!isPublishedRetain(this.#options.retainMs)) {
      this.#cache.delete(key);
      this.#unavailable.delete(key);
      this.#idleAt.delete(key);
      this.#log.info({ marketId, interval }, 'ws: candle cache dropped — no subscribers');
      return;
    }
    this.#idleAt.set(key, this.#lastNow);
  }

  #noteNow(now: number): void {
    this.#lastNow = now;
    this.#expireIdle(now);
  }

  #expireIdle(now: number): void {
    const retain = this.#options.retainMs;
    if (!isPublishedRetain(retain)) return;
    for (const [key, at] of this.#idleAt) {
      if (now - at >= retain) {
        this.#idleAt.delete(key);
        this.#cache.delete(key);
        this.#unavailable.delete(key);
      }
    }
  }

  #overHighWater(sub: Subscription): boolean {
    const limit = this.#options.highWaterBytes;
    return isPublishedHighWaterBytes(limit) && sub.sink.bufferedBytes > limit;
  }

  #sendState(sub: Subscription, _now: number): boolean {
    const cached = this.#cache.get(keyOf(sub.marketId, sub.interval));
    if (!cached || cached.length === 0) return false;
    for (const candle of cached) this.#write(sub, candleFrame(sub.marketId, sub.interval, candle));
    return true;
  }

  #write(sub: Subscription, frame: string): void {
    try {
      sub.sink.send(frame);
      this.#frames += 1;
    } catch (err) {
      this.#evict(sub, 1001, err instanceof Error ? err.message : 'send failed');
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
    this.#forgetIdleKey(sub.marketId, sub.interval);
  }
}

function candleFrame(marketId: string, interval: MuxInterval, candle: CachedCandle): string {
  return JSON.stringify({
    type: 'candle',
    marketId,
    interval,
    t: candle.t,
    o: candle.o,
    h: candle.h,
    l: candle.l,
    c: candle.c,
    v: candle.v,
    closed: candle.closed,
  });
}

function statusFrame(marketId: string, interval: MuxInterval): string {
  return JSON.stringify({ type: 'status', code: CANDLES_UNAVAILABLE, marketId, interval });
}
