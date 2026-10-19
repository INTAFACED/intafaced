import type { BookTop, MarketDataAdapter, PriceLevel } from '@intafaced/venue-contracts';
import { SequencedBookTracker, type DesyncEvent, type TrackerOptions } from './sequenced-book.js';
import { VenueLatencyGrader } from './latency.js';

/**
 * THE MAINTAINED BOOK — subscribe, buffer, snapshot, and resnapshot on a gap.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORDER OF OPERATIONS IS THE WHOLE FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **Open the stream.**
 * 2. **Buffer everything it sends.**
 * 3. **Then** fetch the snapshot.
 * 4. Join, checking that the buffered stream is contiguous with the snapshot.
 * 5. If it is not — the snapshot predates the buffer — fetch a NEWER snapshot
 *    and try again. Do not go live.
 *
 * Snapshot-then-subscribe is the obvious order and it is wrong. Updates that
 * land between the fetch and the subscription are lost, and they are lost with
 * NO sequence discontinuity afterwards, because the snapshot's sequence is
 * already past them. Every delta that follows is contiguous with every other
 * delta, the gap detector reports a healthy book forever, and the book is
 * missing whatever changed in that window.
 *
 * That is the single most expensive bug available in this package, and the only
 * defence is doing these five steps in this order.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RESNAPSHOTTING IS BOUNDED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A venue that is genuinely broken will gap, resnapshot, and gap again — and an
 * unbounded loop turns that into a request storm that gets us rate-limited or
 * banned, which is an outage we caused on top of the venue's. `maxResyncs`
 * caps it: past the cap the feed STOPS and reports, rather than fighting.
 *
 * A stopped feed is a venue that is excluded and reported (§27). A feed that
 * keeps hammering is a venue that is excluded, unreported, and taking the rest
 * of the fabric's rate limit with it.
 */

export interface BookFeedOptions extends TrackerOptions {
  readonly depthLimit?: number;
  /**
   * How many snapshot attempts before giving up on the join.
   *
   * A snapshot that keeps arriving older than the buffered stream means the REST
   * endpoint is lagging its own websocket, which happens. Retrying forever
   * against it is a request storm; three attempts and an honest failure is not.
   */
  readonly maxSnapshotAttempts?: number;
  /** Gap-driven rebuilds allowed before the feed stops. See the header. */
  readonly maxResyncs?: number;
  readonly grader?: VenueLatencyGrader;
  readonly clock?: () => number;
}

const DEFAULTS = { depthLimit: 1_000, maxSnapshotAttempts: 3, maxResyncs: 20 } as const;

export type BookFeedStatus =
  | { readonly kind: 'starting' }
  | { readonly kind: 'live'; readonly sequence: number }
  /** A gap was seen; a fresh snapshot is being fetched. The book is withheld. */
  | { readonly kind: 'resyncing'; readonly desync: DesyncEvent; readonly attempt: number }
  /** Stopped for good, with the reason. Excluded and reported. */
  | { readonly kind: 'stopped'; readonly reason: string };

/**
 * A continuously-maintained book for one symbol on one venue.
 *
 * `top()` and `levels()` return `null`/`[]` whenever the book is not proven
 * current. There is no accessor that returns a possibly-stale book, because a
 * caller offered one would use it.
 */
export class MaintainedBook {
  readonly venueId: string;
  readonly symbol: string;
  readonly tracker: SequencedBookTracker;

  #status: BookFeedStatus = { kind: 'starting' };
  #subscription: { close(): Promise<void> } | null = null;
  #stopped = false;
  #resyncs = 0;
  /** Bumped by every `#seed`. A completion that is not this number is stale. */
  #seedGeneration = 0;

  readonly #adapter: MarketDataAdapter;
  readonly #options: BookFeedOptions & Required<Pick<BookFeedOptions, 'depthLimit' | 'maxSnapshotAttempts' | 'maxResyncs'>>;
  readonly #grader: VenueLatencyGrader | null;
  readonly #clock: () => number;

  constructor(adapter: MarketDataAdapter, symbol: string, options: BookFeedOptions = {}) {
    this.#adapter = adapter;
    this.venueId = adapter.venue.id;
    this.symbol = symbol;
    this.#options = { ...DEFAULTS, ...options };
    this.#grader = options.grader ?? null;
    this.#clock = options.clock ?? Date.now;
    this.tracker = new SequencedBookTracker(adapter.venue.id, symbol, options);
  }

  get status(): BookFeedStatus {
    return this.#status;
  }

  /** True only while every update since the snapshot has been proven contiguous. */
  get servable(): boolean {
    return this.tracker.servable && !this.#stopped;
  }

  top(): BookTop | null {
    return this.servable ? this.tracker.top() : null;
  }

  levels(side: 'bids' | 'asks'): PriceLevel[] {
    return this.servable ? this.tracker.levels(side) : [];
  }

  /**
   * Run the feed until it is stopped or gives up.
   *
   * Returns rather than throwing on a venue failure: a venue going away is an
   * expected condition, and the caller needs the final status to report it.
   */
  async run(): Promise<BookFeedStatus> {
    const subscription = await this.#adapter.streamBook(this.symbol);
    this.#subscription = subscription;

    // Steps 1 and 2 are already done by the time the first delta is read: the
    // subscription is open and the tracker buffers everything until a snapshot
    // lands. Step 3 runs concurrently with that buffering, on purpose.
    void this.#seed();

    try {
      for await (const delta of subscription.deltas) {
        if (this.#stopped) break;

        const outcome = this.tracker.onDelta(delta);

        if (outcome.kind === 'desynced') {
          this.#resyncs += 1;
          if (this.#resyncs > this.#options.maxResyncs) {
            return this.#stop(
              `${this.venueId}:${this.symbol} desynced ${this.#resyncs} times (${outcome.reason}: ${outcome.detail}) — ` +
                'stopping rather than resnapshot-storming the venue',
            );
          }
          this.#status = {
            kind: 'resyncing',
            desync: this.tracker.lastDesync as DesyncEvent,
            attempt: this.#resyncs,
          };
          // Deltas keep arriving and keep being buffered while this runs, so the
          // fresh snapshot has something to join to.
          void this.#seed();
          continue;
        }

        if (outcome.kind === 'applied') {
          this.#status = { kind: 'live', sequence: outcome.sequence };
        }
      }
    } catch (error) {
      return this.#stop(`${this.venueId}:${this.symbol} stream failed: ${String(error)}`);
    }

    return this.#stopped ? this.#status : this.#stop(`${this.venueId}:${this.symbol} stream ended`);
  }

  async close(): Promise<void> {
    this.#stopped = true;
    await this.#subscription?.close();
  }

  /**
   * Steps 3–5: fetch a snapshot and join, retrying while it arrives too old.
   *
   * "Too old" is not a transport failure — the snapshot arrived fine, it is just
   * behind the stream we have already buffered. The only fix is another
   * snapshot, and the only safe alternative to retrying is refusing to go live.
   */
  async #seed(): Promise<void> {
    const generation = ++this.#seedGeneration;
    // Stop, or a newer seed, during the await: do not go live and do not #stop.
    const abandoned = (): boolean => this.#stopped || generation !== this.#seedGeneration;

    for (let attempt = 1; attempt <= this.#options.maxSnapshotAttempts; attempt += 1) {
      if (abandoned()) return;

      let snapshot;
      const started = this.#clock();
      try {
        snapshot = await this.#adapter.snapshotBook(this.symbol, this.#options.depthLimit);
        this.#grader?.observe({ roundTripMs: this.#clock() - started, outcome: 'ok', at: new Date(this.#clock()) });
      } catch (error) {
        this.#grader?.observe({ roundTripMs: this.#clock() - started, outcome: 'error', at: new Date(this.#clock()) });
        if (abandoned()) return;
        if (attempt === this.#options.maxSnapshotAttempts) {
          this.#stop(`${this.venueId}:${this.symbol} could not fetch a snapshot: ${String(error)}`);
        }
        continue;
      }

      if (abandoned()) return;

      const outcome = this.tracker.onSnapshot(snapshot);
      if (outcome.kind === 'applied') {
        this.#status = { kind: 'live', sequence: this.tracker.sequence };
        return;
      }
      if (outcome.kind !== 'snapshot-stale') {
        this.#stop(`${this.venueId}:${this.symbol} snapshot refused: ${JSON.stringify(outcome)}`);
        return;
      }
      // `snapshot-stale`: loop and fetch a newer one. The book stays withheld.
    }

    if (abandoned()) return;
    this.#stop(
      `${this.venueId}:${this.symbol} could not join the stream after ${this.#options.maxSnapshotAttempts} snapshots — ` +
        'the REST endpoint is lagging its own websocket',
    );
  }

  #stop(reason: string): BookFeedStatus {
    // The first reason stands. Closing the subscription is what unblocks run()
    // on a quiet book; a later stream error or end must not replace it.
    if (this.#status.kind === 'stopped') return this.#status;
    this.#stopped = true;
    this.#status = { kind: 'stopped', reason };
    void this.#subscription?.close().catch(() => undefined);
    return this.#status;
  }
}
