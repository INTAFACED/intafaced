import { createHash, randomUUID } from 'node:crypto';
import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_POLICY, CLOSE_TRY_LATER, type DepthSink, type HubLogger } from '../depth/hub.js';
import { isPublishedHighWaterBytes } from '../high-water-bytes.js';
import { isPublishedConnectionCeiling } from '../max-connections.js';
import { isPublishedMaxLagTicks } from '../max-lag-ticks.js';
import { SLOW_CONSUMER_PREFIX, type InstrumentsResume } from './protocol.js';

/**
 * EVERY MARKET'S STATE, AS A STREAM (SP-markets-data-01, J-cex-spot-14 #8).
 *
 * The rows come from svc-trade's public market list (`GET /api/v1/markets`, each row carrying its public lifecycle
 * state), polled by `mux/poller.ts` only while somebody is subscribed. This hub owns no timer and no I/O.
 *
 * ── One sequence ────────────────────────────────────────────────────────────
 *
 * The snapshot and the events share one sequence number. A snapshot carries the sequence it is current as of; every
 * change after it is one `event` frame with the next sequence, in order. A market whose state did not change sends
 * nothing: reading the same state twice is not an event (a duplicate publish is ignored by its id, which is the market,
 * the state it left and the state it entered, at that sequence). A market that leaves the list is an event to state
 * `UNLISTED`; one that joins is an event from `UNLISTED`.
 *
 * ── Resume ──────────────────────────────────────────────────────────────────
 *
 * Every frame names the stream's `epoch`, one per svc-ws process. A client that reconnects subscribes with
 * `resume: { epoch, sequence }`, the last frame it applied. If the epoch is this one and every event after that sequence
 * is still held, it gets a `resume` frame and then exactly those events, in order: it resumes from its last sequence.
 * Otherwise (another epoch after a restart, a sequence ahead of the stream, or events no longer held) it gets a
 * `snapshot` with `reason: "gap"`: a gap forces a snapshot, never a silent skip. The hub holds the newest
 * `INSTRUMENTS_REPLAY_EVENTS` events, a wire-format bound like the protocol's other constants, not a tunable.
 *
 * ── Backpressure ────────────────────────────────────────────────────────────
 *
 * As the ticker hub: over the high-water mark an event is dropped and the client marked lagging; on the first flush
 * where its buffer has drained it gets a full snapshot; one still over the mark after `maxLagTicks` flushes is closed
 * 1013 as a slow consumer. No per-client queue.
 */

export const INSTRUMENTS_UNAVAILABLE = 'instruments.unavailable' as const;
/** Events held for a resume. Past this a reconnect gets a snapshot. */
export const INSTRUMENTS_REPLAY_EVENTS = 1024;
/** The state a market is in when the list does not hold it. */
export const UNLISTED = 'UNLISTED' as const;

/** One market as the instruments stream shows it. `state` is svc-trade's public lifecycle state; null when it published none. */
export interface InstrumentRow {
  readonly market: string;
  readonly symbol: string;
  readonly base: string | null;
  readonly quote: string | null;
  readonly state: string | null;
  readonly reasonCode: string | null;
}

export interface InstrumentEvent {
  readonly type: 'event';
  readonly epoch: string;
  readonly sequence: number;
  readonly id: string;
  readonly market: string;
  readonly symbol: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly reasonCode: string | null;
}

export interface InstrumentsHubOptions {
  readonly highWaterBytes: number | undefined;
  readonly maxLagTicks: number | undefined;
  readonly maxConnections: number | undefined;
  /** Called (not awaited) when a subscriber arrives and there is nothing read yet to give it. */
  readonly onDemand?: () => void;
  /** Fixed in tests; one random epoch per process otherwise. */
  readonly epoch?: string;
}

interface Subscription {
  readonly sink: DepthSink;
  lagTicks: number;
  lagging: boolean;
  /** Attached before the first read: it gets its snapshot when one arrives. */
  waiting: boolean;
  closed: boolean;
}

const NO_LOG: HubLogger = { info: () => undefined, warn: () => undefined };

function sameRow(a: InstrumentRow | undefined, b: InstrumentRow): boolean {
  return a !== undefined && a.state === b.state && a.reasonCode === b.reasonCode && a.symbol === b.symbol;
}

export function instrumentEventId(market: string, from: string | null, to: string | null, sequence: number): string {
  return createHash('sha256')
    .update(`${market}|${from ?? ''}|${to ?? ''}|${sequence}`)
    .digest('hex')
    .slice(0, 32);
}

export class InstrumentsHub {
  readonly #options: InstrumentsHubOptions;
  readonly #log: HubLogger;
  readonly #epoch: string;
  readonly #subscriptions = new Set<Subscription>();
  readonly #rows = new Map<string, InstrumentRow>();
  readonly #events: InstrumentEvent[] = [];
  #sequence = 0;
  #loaded = false;
  #unavailable = false;

  constructor(options: InstrumentsHubOptions, log: HubLogger = NO_LOG) {
    this.#options = options;
    this.#log = log;
    this.#epoch = options.epoch ?? randomUUID();
  }

  get epoch(): string {
    return this.#epoch;
  }

  get sequence(): number {
    return this.#sequence;
  }

  get connections(): number {
    return this.#subscriptions.size;
  }

  /** Register a sink, resuming from `resume` when it can. Returns detach, or null when refused (the sink is closed with why). */
  attach(sink: DepthSink, resume?: InstrumentsResume): (() => void) | null {
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
    const sub: Subscription = { sink, lagTicks: 0, lagging: false, waiting: false, closed: false };
    this.#subscriptions.add(sub);
    if (this.#unavailable) this.#write(sub, this.#statusFrame());
    else if (!this.#loaded) {
      sub.waiting = true;
      this.#options.onDemand?.();
    } else if (resume !== undefined) this.#resume(sub, resume);
    else this.#write(sub, this.#snapshotFrame(null));
    return () => {
      sub.closed = true;
      this.#subscriptions.delete(sub);
    };
  }

  /** Client-asked repair: the full current state, once. */
  resync(sink: DepthSink): 'sent' | 'deferred' | 'absent' | 'not_subscribed' {
    const sub = [...this.#subscriptions].find((s) => s.sink === sink && !s.closed);
    if (!sub) return 'not_subscribed';
    if (this.#unavailable) {
      this.#write(sub, this.#statusFrame());
      return 'sent';
    }
    if (!this.#loaded) return 'absent';
    if (this.#over(sub)) {
      sub.lagging = true;
      return 'deferred';
    }
    this.#write(sub, this.#snapshotFrame(null));
    return 'sent';
  }

  /**
   * Take a fresh market list as the truth. Each market whose state changed (or that joined or left) becomes one event
   * with the next sequence, sent to every subscriber in order. The first read becomes the state, with no events.
   */
  ingest(rows: readonly InstrumentRow[]): void {
    const wasUnavailable = this.#unavailable;
    this.#unavailable = false;
    const fresh = new Map(rows.map((row) => [row.market, row]));
    if (!this.#loaded) {
      for (const [market, row] of fresh) this.#rows.set(market, row);
      this.#loaded = true;
      for (const sub of [...this.#subscriptions]) if (!sub.closed) this.#write(sub, this.#snapshotFrame(null));
      for (const sub of this.#subscriptions) sub.waiting = false;
      return;
    }
    const events: InstrumentEvent[] = [];
    const markets = [...new Set([...this.#rows.keys(), ...fresh.keys()])].sort();
    for (const market of markets) {
      const before = this.#rows.get(market);
      const after = fresh.get(market);
      if (after !== undefined && sameRow(before, after)) continue;
      if (before === undefined && after === undefined) continue;
      const from = before === undefined ? UNLISTED : before.state;
      const to = after === undefined ? UNLISTED : after.state;
      if (after === undefined) this.#rows.delete(market);
      else this.#rows.set(market, after);
      if (from === to && before?.reasonCode === after?.reasonCode) continue;
      this.#sequence += 1;
      events.push({
        type: 'event',
        epoch: this.#epoch,
        sequence: this.#sequence,
        id: instrumentEventId(market, from, to, this.#sequence),
        market,
        symbol: (after ?? before)!.symbol,
        from,
        to,
        reasonCode: after?.reasonCode ?? null,
      });
    }
    for (const event of events) {
      this.#events.push(event);
      if (this.#events.length > INSTRUMENTS_REPLAY_EVENTS) this.#events.shift();
    }
    for (const sub of [...this.#subscriptions]) {
      if (sub.closed) continue;
      if (wasUnavailable || sub.waiting) {
        sub.waiting = false;
        this.#write(sub, this.#snapshotFrame(null));
        continue;
      }
      for (const event of events) this.#send(sub, JSON.stringify(event));
    }
  }

  /** The source could not be read: say so, never a stale list as if it were current. */
  markUnavailable(): void {
    if (this.#unavailable) return;
    this.#unavailable = true;
    this.#log.warn({ code: INSTRUMENTS_UNAVAILABLE }, 'ws: instruments list unreadable — disclosing instruments.unavailable');
    for (const sub of [...this.#subscriptions]) if (!sub.closed) this.#write(sub, this.#statusFrame());
  }

  /** The lag sweep. Call on every tick, so a client that lagged into a quiet stream is still repaired. */
  flush(): void {
    for (const sub of [...this.#subscriptions]) {
      if (sub.closed || !sub.lagging) continue;
      if (this.#over(sub)) {
        sub.lagTicks += 1;
        if (sub.lagTicks > (this.#options.maxLagTicks ?? 0)) {
          sub.closed = true;
          this.#subscriptions.delete(sub);
          sub.sink.close(CLOSE_TRY_LATER, `${SLOW_CONSUMER_PREFIX}: instruments`);
        }
        continue;
      }
      sub.lagging = false;
      sub.lagTicks = 0;
      if (this.#loaded && !this.#unavailable) this.#write(sub, this.#snapshotFrame(null));
    }
  }

  #resume(sub: Subscription, resume: InstrumentsResume): void {
    const oldest = this.#events[0]?.sequence ?? this.#sequence + 1;
    const held = resume.epoch === this.#epoch && resume.sequence <= this.#sequence && resume.sequence >= oldest - 1;
    if (!held) {
      this.#write(sub, this.#snapshotFrame('gap'));
      return;
    }
    this.#write(sub, JSON.stringify({ type: 'resume', epoch: this.#epoch, fromSequence: resume.sequence, sequence: this.#sequence }));
    for (const event of this.#events) if (event.sequence > resume.sequence) this.#send(sub, JSON.stringify(event));
  }

  #snapshotFrame(reason: 'gap' | null): string {
    const instruments = [...this.#rows.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
    return JSON.stringify({ type: 'snapshot', epoch: this.#epoch, sequence: this.#sequence, ...(reason ? { reason } : {}), instruments });
  }

  #statusFrame(): string {
    return JSON.stringify({ type: 'status', code: INSTRUMENTS_UNAVAILABLE, epoch: this.#epoch });
  }

  #over(sub: Subscription): boolean {
    return sub.sink.bufferedBytes > (this.#options.highWaterBytes ?? 0);
  }

  /** An event: dropped (and the client marked lagging) when its buffer is over the mark. */
  #send(sub: Subscription, frame: string): void {
    if (sub.lagging || this.#over(sub)) {
      sub.lagging = true;
      return;
    }
    sub.sink.send(frame);
  }

  /** A snapshot, resume or status frame: always written; a later event can't land on a book the client doesn't hold. */
  #write(sub: Subscription, frame: string): void {
    sub.sink.send(frame);
  }
}
