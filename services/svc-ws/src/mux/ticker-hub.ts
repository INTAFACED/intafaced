import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_POLICY, CLOSE_TRY_LATER, type DepthSink, type HubLogger } from '../depth/hub.js';
import { isPublishedHighWaterBytes } from '../high-water-bytes.js';
import { isPublishedConnectionCeiling } from '../max-connections.js';
import { isPublishedMaxLagTicks } from '../max-lag-ticks.js';

/**
 * ALL-MARKETS TICKER FAN-OUT.
 *
 * One row per market: last price, 24 h change, high, low, volume. The rows come
 * from svc-trade's `GET /api/v1/tickers` (real, non-seeded taker fills — the
 * same numbers the REST ticker and the market table already show), polled by
 * `mux/poller.ts` only while somebody is subscribed. This hub owns no timer and
 * no I/O: the caller drives `ingest` and `flush` with a clock, so every rule
 * below is reachable from a test without waiting.
 *
 * ── The throttle ────────────────────────────────────────────────────────────
 *
 * A market's row is sent at most once per `throttleMs` (about one a second).
 * The throttle is trailing-edge and per market: a market that changes ten times
 * inside the window is sent once, with its newest values, as soon as the window
 * is over. A market that did not change is never sent. Rows that became
 * eligible together travel in ONE frame, so thirty markets are one message, not
 * thirty.
 *
 * ── Absence is not zero ─────────────────────────────────────────────────────
 *
 * A field the source did not publish (a market that never traded has no 24 h
 * high) is `null` on the wire, never `"0"`. A market svc-trade omitted from the
 * map (matching holds no book for it) gets no row at all.
 *
 * ── Backpressure ────────────────────────────────────────────────────────────
 *
 * Same policy as depth, adapted to a latest-state feed: over the high-water mark
 * the update is dropped (a ticker row is state, so the next full snapshot
 * repairs any amount of loss); the client is marked lagging; on the first tick
 * where its buffer has drained it gets a full `snapshot`; one still over the
 * mark after `maxLagTicks` consecutive ticks is closed with 1013. No per-client
 * queue.
 */

export const TICKER_UNAVAILABLE = 'ticker.unavailable' as const;

/** One market's 24 h facts. Amounts are decimal strings; `null` is "not published", never zero. */
export interface TickerRow {
  /** Canonical market id (the same id `book` / `trades` use). */
  readonly market: string;
  /** Unified symbol, e.g. `BTC/USDT`. */
  readonly symbol: string;
  readonly last: string | null;
  /** Absolute 24 h change (last − open). */
  readonly change24h: string | null;
  /** 24 h change in percent (not a ratio). */
  readonly changePct24h: string | null;
  readonly high: string | null;
  readonly low: string | null;
  /** Base-asset volume over the 24 h window. */
  readonly volume: string | null;
  readonly quoteVolume: string | null;
}

export interface TickerHubOptions {
  readonly highWaterBytes: number | undefined;
  readonly maxLagTicks: number | undefined;
  readonly maxConnections: number | undefined;
  /** Minimum spacing between two sends of the same market. */
  readonly throttleMs: number;
  /** Called (not awaited) when a subscriber arrives and there is nothing cached to give it. */
  readonly onDemand?: () => void;
}

interface Subscription {
  readonly sink: DepthSink;
  /** `null` = every market. */
  readonly market: string | null;
  lagTicks: number;
  lagging: boolean;
  closed: boolean;
}

const NO_LOG: HubLogger = { info: () => undefined, warn: () => undefined };

function sameRow(a: TickerRow | undefined, b: TickerRow): boolean {
  return (
    a !== undefined &&
    a.symbol === b.symbol &&
    a.last === b.last &&
    a.change24h === b.change24h &&
    a.changePct24h === b.changePct24h &&
    a.high === b.high &&
    a.low === b.low &&
    a.volume === b.volume &&
    a.quoteVolume === b.quoteVolume
  );
}

export class TickerHub {
  readonly #options: TickerHubOptions;
  readonly #log: HubLogger;
  readonly #subscriptions = new Set<Subscription>();
  /** Newest known row per market. Kept only while somebody is watching. */
  readonly #cache = new Map<string, TickerRow>();
  /** What was last sent for a market, and when. */
  readonly #sent = new Map<string, { row: TickerRow; at: number }>();
  /** Markets whose cached row differs from what was last sent. */
  readonly #dirty = new Set<string>();
  #unavailable = false;
  #droppedFrames = 0;
  #evictions = 0;
  #repairs = 0;
  #frames = 0;

  constructor(options: TickerHubOptions, log: HubLogger = NO_LOG) {
    this.#options = options;
    this.#log = log;
  }

  get connections(): number {
    return this.#subscriptions.size;
  }

  get maxConnections(): number | undefined {
    return this.#options.maxConnections;
  }

  get throttleMs(): number {
    return this.#options.throttleMs;
  }

  get available(): boolean {
    return !this.#unavailable;
  }

  get stats(): { connections: number; markets: number; frames: number; droppedFrames: number; evictions: number; repairs: number } {
    return {
      connections: this.#subscriptions.size,
      markets: this.#cache.size,
      frames: this.#frames,
      droppedFrames: this.#droppedFrames,
      evictions: this.#evictions,
      repairs: this.#repairs,
    };
  }

  /** The cached row for one market, if any. */
  rowFor(market: string): TickerRow | undefined {
    return this.#cache.get(market);
  }

  /**
   * Register a sink for every market (`market === null`) or one. Returns detach,
   * or `null` when refused (the sink has already been closed with the reason).
   * A new subscriber is handed the cached state at once, so it never waits a
   * full poll for its first frame.
   */
  attach(market: string | null, sink: DepthSink, now: number = Date.now()): (() => void) | null {
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

    const sub: Subscription = { sink, market, lagTicks: 0, lagging: false, closed: false };
    this.#subscriptions.add(sub);

    if (this.#unavailable) this.#write(sub, statusFrame());
    else if (this.#cache.size > 0) this.#sendSnapshot(sub, now);
    else this.#options.onDemand?.();

    return () => {
      sub.closed = true;
      this.#subscriptions.delete(sub);
      if (this.#subscriptions.size === 0) this.#forgetAll();
    };
  }

  /** Client-requested repair: the full current state, once. Returns false when there is nothing true to send. */
  resync(sink: DepthSink, now: number = Date.now()): 'sent' | 'deferred' | 'absent' | 'not_subscribed' {
    const sub = [...this.#subscriptions].find((s) => s.sink === sink && !s.closed);
    if (!sub) return 'not_subscribed';
    if (this.#unavailable) {
      this.#write(sub, statusFrame());
      return 'sent';
    }
    if (this.#overHighWater(sub)) {
      sub.lagging = true;
      return 'deferred';
    }
    if (!this.#sendSnapshot(sub, now)) return 'absent';
    this.#repairs += 1;
    return 'sent';
  }

  /**
   * Take a fresh upstream map as the new truth. Rows the source no longer lists
   * are dropped (absence, not a stale price). Then flush whatever is eligible.
   */
  ingest(rows: readonly TickerRow[], now: number): void {
    if (this.#subscriptions.size === 0) return;
    const wasUnavailable = this.#unavailable;
    this.#unavailable = false;

    const present = new Set<string>();
    for (const row of rows) {
      present.add(row.market);
      this.#cache.set(row.market, row);
      if (sameRow(this.#sent.get(row.market)?.row, row)) this.#dirty.delete(row.market);
      else this.#dirty.add(row.market);
    }
    for (const market of [...this.#cache.keys()]) {
      if (present.has(market)) continue;
      this.#cache.delete(market);
      this.#sent.delete(market);
      this.#dirty.delete(market);
    }

    if (wasUnavailable) {
      // Everyone was told the feed was down; the first real state after it is a full snapshot.
      for (const sub of [...this.#subscriptions]) if (!sub.closed) this.#sendSnapshot(sub, now);
      for (const market of this.#dirty) this.#markSent(market, now);
      this.#dirty.clear();
      return;
    }
    this.flush(now);
  }

  /**
   * Send what the throttle allows, and run the lag sweep. Call on every tick —
   * a client that lagged into a quiet feed is still repaired.
   */
  flush(now: number): void {
    const repaired = new Set<Subscription>();
    const overNow = new Set<Subscription>();

    for (const sub of [...this.#subscriptions]) {
      if (sub.closed) continue;
      if (this.#overHighWater(sub)) {
        sub.lagging = true;
        sub.lagTicks += 1;
        overNow.add(sub);
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
      if (sub.lagging && !this.#unavailable) {
        sub.lagging = false;
        this.#repairs += 1;
        this.#sendSnapshot(sub, now);
        repaired.add(sub);
      }
    }

    if (this.#unavailable || this.#dirty.size === 0) return;
    const eligible: TickerRow[] = [];
    for (const market of this.#dirty) {
      const sent = this.#sent.get(market);
      if (sent !== undefined && now - sent.at < this.#options.throttleMs) continue;
      const row = this.#cache.get(market);
      if (row) eligible.push(row);
    }
    if (eligible.length === 0) return;
    for (const row of eligible) {
      this.#markSent(row.market, now);
      this.#dirty.delete(row.market);
    }

    for (const sub of [...this.#subscriptions]) {
      if (sub.closed || repaired.has(sub)) continue;
      if (overNow.has(sub)) {
        this.#droppedFrames += 1;
        continue;
      }
      const mine = sub.market === null ? eligible : eligible.filter((row) => row.market === sub.market);
      if (mine.length > 0) this.#write(sub, rowsFrame('update', now, mine));
    }
  }

  /** The upstream could not be read. Named once per down-edge; cached rows stop being truth. */
  markUnavailable(): void {
    if (this.#unavailable) return;
    this.#unavailable = true;
    this.#dirty.clear();
    this.#sent.clear();
    this.#cache.clear();
    const frame = statusFrame();
    for (const sub of [...this.#subscriptions]) if (!sub.closed) this.#write(sub, frame);
  }

  closeAll(code: number, reason: string): void {
    for (const sub of [...this.#subscriptions]) this.#evict(sub, code, reason);
    this.#forgetAll();
  }

  #markSent(market: string, now: number): void {
    const row = this.#cache.get(market);
    if (row) this.#sent.set(market, { row, at: now });
  }

  #overHighWater(sub: Subscription): boolean {
    const limit = this.#options.highWaterBytes;
    return isPublishedHighWaterBytes(limit) && sub.sink.bufferedBytes > limit;
  }

  #sendSnapshot(sub: Subscription, now: number): boolean {
    const rows = [...this.#cache.values()].filter((row) => sub.market === null || row.market === sub.market);
    if (rows.length === 0) return false;
    this.#write(sub, rowsFrame('snapshot', now, rows));
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
    if (this.#subscriptions.size === 0) this.#forgetAll();
  }

  /** Nobody is watching, so nothing cached is truth any more. */
  #forgetAll(): void {
    this.#cache.clear();
    this.#sent.clear();
    this.#dirty.clear();
    this.#unavailable = false;
    this.#log.info({}, 'ws: ticker cache dropped — no subscribers');
  }
}

function rowsFrame(type: 'snapshot' | 'update', now: number, rows: readonly TickerRow[]): string {
  return JSON.stringify({ type, ts: now, tickers: rows });
}

function statusFrame(): string {
  return JSON.stringify({ type: 'status', code: TICKER_UNAVAILABLE });
}
