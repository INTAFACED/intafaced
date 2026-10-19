import { formatAmount, type Amount } from '@intafaced/ledger-client/money';
import { applyDelta, bookFromSnapshot, type DepthBook, type WireLevel } from '@intafaced/market-data';
import {
  isCrossed,
  readDecimal,
  topOfBook,
  type BookSyncState,
  type BookTop,
  type PriceLevel,
  type VenueBookDelta,
  type VenueBookSnapshot,
} from '@intafaced/venue-contracts';

/**
 * THE SEQUENCED BOOK TRACKER — §27's "WS-first, sequenced books, gap-detected".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAILURE THIS FILE EXISTS TO MAKE IMPOSSIBLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A websocket depth stream that silently drops one update leaves a book that
 * answers every question instantly, renders perfectly, and is WRONG. There is
 * no symptom: no exception, no latency spike, no gap in a log. Just a price that
 * was never on the venue, handed to a router that has no way to doubt it. The
 * first anyone knows is a fill at a level nobody was offering.
 *
 * So this tracker has one non-negotiable property, and everything else in the
 * file is in service of it:
 *
 *   **`book()` returns `null` unless every update since the snapshot has been
 *   proven contiguous.** A gap does not degrade the book, it withholds it.
 *
 * Serving a desynced book "because it is probably still close" is the same bug
 * as not checking at all, only deliberate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE JOIN — the window a gap detector cannot see
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The subtle failure is not the gap mid-stream. It is the join: you fetch a
 * snapshot over REST and you subscribe over WS, and updates that land between
 * the two are lost with NO sequence discontinuity to prove it — because the
 * snapshot's sequence is already past them.
 *
 * The only correct order is: **subscribe first, buffer deltas, then snapshot.**
 * Then the join is arithmetic rather than luck: the first buffered delta not
 * already contained in the snapshot must satisfy
 *
 *     firstSequence <= snapshot.sequence + 1 <= lastSequence
 *
 * If it starts later than that, updates were lost and the SNAPSHOT IS TOO OLD —
 * fetch a newer one. This tracker refuses to go live until that holds, which is
 * why `onSnapshot` can answer `snapshot-stale` and why a caller must loop.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY SEQUENCES ARE RANGES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Venues coalesce several updates into one frame under load, and publish the
 * range they cover. A tracker that assumed one update per message would call
 * every batched frame a gap and resnapshot forever — turning a busy market into
 * a self-inflicted outage. Hence `firstSequence`/`lastSequence`, and hence the
 * `<=` on the left of the join condition: an OVERLAPPING batch is fine, because
 * levels are absolute totals and re-applying one is idempotent. Only a batch
 * that starts strictly beyond `sequence + 1` is a gap.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS DELEGATED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The mutation itself is `@intafaced/market-data`'s `applyDelta` — this repo's
 * prior art, already property-tested against `diffDepth` over generated books.
 * A second implementation of the same walk is a second thing to be wrong, and
 * the server that produces our own deltas uses that one.
 *
 * Its sequence check then runs a second time, on data this file has already
 * validated. That redundancy is intentional: it is an assertion that the
 * translation from venue ranges to `market-data`'s single-step model is right,
 * and it fires in tests rather than in production.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MONEY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every wire level is read through `readDecimal` before it reaches the book, so
 * a venue that starts emitting JSON numbers is refused at the boundary rather
 * than silently rounded into the depth. Prices are canonicalised through
 * `formatAmount` so `"30000"` and `"30000.0"` cannot become two levels at one
 * price — a duplicate level is phantom liquidity, and the router would size
 * against it.
 */

export type DesyncReason =
  /** A delta started beyond `sequence + 1`. Updates were lost. */
  | 'gap'
  /** `applyDelta` refused a delta this file believed contiguous. A translation bug. */
  | 'internal-inconsistency'
  /**
   * Best bid landed at or above best ask. Impossible on one venue, so our copy
   * is wrong — usually a missed removal. Catches what sequence numbers cannot:
   * a venue whose own numbering is correct and whose payload is not.
   */
  | 'crossed';

export type TrackerOutcome =
  /** Applied and contiguous. The book is servable. */
  | { readonly kind: 'applied'; readonly state: 'live'; readonly sequence: number }
  /** Held until a snapshot lands. Not an error — this is the join working. */
  | { readonly kind: 'buffered'; readonly state: BookSyncState; readonly buffered: number }
  /** Already contained in the book. Normal on a reconnect; NOT a gap. */
  | { readonly kind: 'ignored'; readonly reason: 'already-applied' | 'wrong-market'; readonly state: BookSyncState }
  /**
   * The snapshot is older than the deltas already buffered. Fetch a newer one;
   * do NOT go live. See "the join" above.
   */
  | { readonly kind: 'snapshot-stale'; readonly state: BookSyncState; readonly detail: string }
  /** The book must not be served until a fresh snapshot lands. */
  | { readonly kind: 'desynced'; readonly state: 'desynced'; readonly reason: DesyncReason; readonly detail: string }
  /** The venue declares itself unsequenced; a delta from it cannot be gap-checked. */
  | { readonly kind: 'refused'; readonly detail: string; readonly state: BookSyncState };

export interface TrackerOptions {
  /**
   * How many deltas may be held while waiting for a snapshot.
   *
   * Bounded because an unbounded buffer is a memory leak with a market-shaped
   * trigger: the busiest moment is exactly when the snapshot fetch is slowest.
   * On overflow the OLDEST is dropped, which is safe only because the join
   * condition still runs afterwards — a dropped-but-needed delta shows up as a
   * `snapshot-stale`, never as a silently-joined book.
   */
  readonly maxBufferedDeltas?: number;
  /** Treat a crossed book as a desync. On by default; see `DesyncReason`. */
  readonly rejectCrossedBook?: boolean;
}

const DEFAULTS = { maxBufferedDeltas: 512, rejectCrossedBook: true } as const;

export interface DesyncEvent {
  readonly reason: DesyncReason;
  readonly detail: string;
  readonly at: Date;
  readonly sequence: number;
}

export class SequencedBookTracker {
  readonly venueId: string;
  readonly symbol: string;

  #state: BookSyncState = 'awaiting-snapshot';
  #book: DepthBook | null = null;
  #buffer: VenueBookDelta[] = [];
  #options: Required<TrackerOptions>;
  #resyncs = 0;
  #droppedFromBuffer = 0;
  #lastDesync: DesyncEvent | null = null;
  #observedAt: Date | null = null;
  /**
   * False for a venue that publishes no update numbering (an AMM read at a block
   * height, an OTC desk quoting on request). Its book is servable but CANNOT be
   * gap-checked, and a consumer that requires gap detection filters on this.
   * Synthesising a counter of our own would be the worst option available — it
   * would let a consumer believe it could detect a gap on a feed that gives it
   * no way to.
   */
  #gapDetectable = true;

  constructor(venueId: string, symbol: string, options: TrackerOptions = {}) {
    this.venueId = venueId;
    this.symbol = symbol;
    this.#options = { ...DEFAULTS, ...options };
  }

  get state(): BookSyncState {
    return this.#state;
  }

  /** True while `state` is `live`. The one question a consumer should ask. */
  get servable(): boolean {
    return this.#state === 'live';
  }

  /** False on an unsequenced venue. See `#gapDetectable`. */
  get gapDetectable(): boolean {
    return this.#gapDetectable;
  }

  /** `-1` until a snapshot lands. Not `0` — zero is a real first sequence. */
  get sequence(): number {
    return this.#book?.sequence ?? -1;
  }

  /** How many times this tracker has had to rebuild from a snapshot after a gap. */
  get resyncCount(): number {
    return this.#resyncs;
  }

  get bufferedCount(): number {
    return this.#buffer.length;
  }

  /** Deltas discarded to keep the buffer bounded. Non-zero means a slow snapshot fetch. */
  get droppedFromBuffer(): number {
    return this.#droppedFromBuffer;
  }

  get lastDesync(): DesyncEvent | null {
    return this.#lastDesync;
  }

  /** When the last accepted message was observed by THIS process. Our clock, not theirs. */
  get observedAt(): Date | null {
    return this.#observedAt;
  }

  /** True while a fresh snapshot is required — at startup and after a gap alike. */
  needsSnapshot(): boolean {
    return this.#state !== 'live';
  }

  /**
   * The book, or `null`.
   *
   * `null` whenever the book is not proven current. This is the property the
   * whole file exists for; a caller cannot opt out of it, because there is no
   * other accessor.
   */
  book(): DepthBook | null {
    return this.#state === 'live' ? this.#book : null;
  }

  /** Top of book, or `null` when the book is not servable. */
  top(): BookTop | null {
    const book = this.book();
    return book ? topOfBook(this.levels('bids'), this.levels('asks')) : null;
  }

  /** Sorted levels away from the spread. `[]` when the book is not servable. */
  levels(side: 'bids' | 'asks'): PriceLevel[] {
    const book = this.book();
    if (!book) return [];
    const out: PriceLevel[] = [];
    for (const [price, quantity] of book[side]) {
      out.push([readDecimal(price, this.venueId, side), quantity] as PriceLevel);
    }
    out.sort((a, b) => (a[0] === b[0] ? 0 : side === 'bids' ? (a[0] > b[0] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    return out;
  }

  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Seed or re-seed from a full book.
   *
   * Answers `snapshot-stale` when the snapshot is older than the deltas already
   * buffered. A caller MUST loop on that rather than going live — that is the
   * join, and it is the one failure a gap detector cannot catch afterwards.
   */
  onSnapshot(snapshot: VenueBookSnapshot): TrackerOutcome {
    if (snapshot.venueId !== this.venueId || snapshot.symbol !== this.symbol) {
      return { kind: 'ignored', reason: 'wrong-market', state: this.#state };
    }

    this.#observedAt = snapshot.observedAt;

    if (!snapshot.sequenced) {
      // Unsequenced venue: each snapshot replaces the book wholesale. Servable,
      // but `gapDetectable` is false and stays false — the honest statement.
      this.#gapDetectable = false;
      this.#buffer = [];
      this.#book = this.#bookFrom(snapshot);
      this.#state = 'live';
      return { kind: 'applied', state: 'live', sequence: -1 };
    }

    this.#gapDetectable = true;
    const seeded = this.#bookFrom(snapshot);

    // Anything the snapshot already contains is not a gap and not needed.
    const pending = this.#buffer.filter((delta) => delta.sequence.lastSequence > snapshot.sequence);
    const first = pending[0];

    if (first && first.sequence.firstSequence > snapshot.sequence + 1) {
      // The snapshot predates buffered updates. Going live here would join a
      // book to a stream across a hole that nothing downstream could ever see.
      return {
        kind: 'snapshot-stale',
        state: this.#state,
        detail:
          `snapshot at ${snapshot.sequence} is older than the buffered stream, which resumes at ` +
          `${first.sequence.firstSequence} — fetch a newer snapshot`,
      };
    }

    // While the tracker is live the buffer is empty, so the check above never
    // sees the book already held. Equal sequence is a re-seed, not a rewind.
    const held = this.#book?.sequence ?? -1;
    if (snapshot.sequence < held) {
      return {
        kind: 'snapshot-stale',
        state: this.#state,
        detail: `snapshot at ${snapshot.sequence} is behind the book already held at ${held} — fetch a newer snapshot`,
      };
    }

    this.#book = seeded;
    this.#state = 'live';
    this.#buffer = [];

    // Drain what was held during the fetch, through the ordinary path so the
    // contiguity rules are applied exactly once, in one place. The tail of
    // `pending` already arrived: a desync or a throw must not discard it, and
    // a throw must not leave this tracker servable on a drain that did not finish.
    const keepPendingFrom = (from: number): void => {
      for (const later of pending.slice(from)) this.#bufferDelta(later);
    };

    for (let index = 0; index < pending.length; index += 1) {
      const delta = pending[index]!;
      let outcome: TrackerOutcome;
      try {
        outcome = this.onDelta(delta);
      } catch (error) {
        this.#state = 'desynced';
        this.#buffer = [];
        keepPendingFrom(index + 1);
        throw error;
      }
      if (outcome.kind === 'desynced') {
        // `#desync` kept only the delta that failed. Append every later one.
        keepPendingFrom(index + 1);
        return outcome;
      }
    }

    return { kind: 'applied', state: 'live', sequence: this.sequence };
  }

  /**
   * Apply one incremental update, or refuse it and say why.
   *
   * A result rather than a throw: a gap is an expected condition on a lossy
   * transport, not an exception. A caller that must handle it is more likely to
   * than one that may catch it.
   */
  onDelta(delta: VenueBookDelta): TrackerOutcome {
    if (delta.venueId !== this.venueId || delta.symbol !== this.symbol) {
      return { kind: 'ignored', reason: 'wrong-market', state: this.#state };
    }

    if (!this.#gapDetectable) {
      return {
        kind: 'refused',
        state: this.#state,
        detail:
          `${this.venueId} declared itself unsequenced but emitted a delta — ` +
          'an unsequenced delta cannot be gap-checked and will not be applied',
      };
    }

    this.#observedAt = delta.observedAt;

    if (this.#state !== 'live' || !this.#book) {
      this.#bufferDelta(delta);
      return { kind: 'buffered', state: this.#state, buffered: this.#buffer.length };
    }

    const { firstSequence, lastSequence } = delta.sequence;
    const current = this.#book.sequence;

    // Re-delivery is normal on a reconnect. Calling it a gap would send the
    // tracker into a resnapshot loop against a perfectly healthy venue.
    if (lastSequence <= current) {
      return { kind: 'ignored', reason: 'already-applied', state: 'live' };
    }

    if (firstSequence > current + 1) {
      return this.#desync('gap', `expected the next update at ${current + 1}, got a batch starting at ${firstSequence}`, delta);
    }

    // Contiguous or overlapping. Translate the venue's range into the
    // single-step model `market-data` verifies, and let it check us again.
    const applied = applyDelta(this.#book, {
      type: 'delta',
      marketId: this.#book.marketId,
      fromSequence: current,
      sequence: lastSequence,
      bids: this.#wire(delta.bids, 'bids'),
      asks: this.#wire(delta.asks, 'asks'),
    });

    if (!applied.ok) {
      return this.#desync(
        'internal-inconsistency',
        `market-data refused a delta this tracker accepted (${applied.reason}) — translation bug`,
        delta,
      );
    }

    this.#book = applied.book;

    if (this.#options.rejectCrossedBook) {
      const bestBid = this.#best('bids');
      const bestAsk = this.#best('asks');
      if (isCrossed({ bestBid, bestAsk, bestBidQty: null, bestAskQty: null, spread: null, mid: null })) {
        return this.#desync(
          'crossed',
          `best bid ${formatAmount(bestBid as Amount)} is at or above best ask ` +
            `${formatAmount(bestAsk as Amount)} — our copy is wrong, not the venue`,
          delta,
        );
      }
    }

    return { kind: 'applied', state: 'live', sequence: this.#book.sequence };
  }

  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Best price on one side, in a single pass.
   *
   * Deliberately not `levels()` + `topOfBook`: the crossed check runs on EVERY
   * delta, and sorting a thousand-level book a hundred times a second to read
   * two numbers off the front is the kind of cost that gets a safety check
   * switched off later. One pass, no allocation, no sort.
   */
  #best(side: 'bids' | 'asks'): Amount | null {
    const book = this.#book;
    if (!book) return null;
    let best: Amount | null = null;
    for (const price of book[side].keys()) {
      const value = readDecimal(price, this.venueId, side);
      if (best === null || (side === 'bids' ? value > best : value < best)) best = value;
    }
    return best;
  }

  #bookFrom(snapshot: VenueBookSnapshot): DepthBook {
    return bookFromSnapshot({
      type: 'snapshot',
      marketId: `${this.venueId}:${this.symbol}`,
      sequence: snapshot.sequence,
      bids: snapshot.bids.map(([price, qty]) => [formatAmount(price), formatAmount(qty)] as WireLevel),
      asks: snapshot.asks.map(([price, qty]) => [formatAmount(price), formatAmount(qty)] as WireLevel),
    });
  }

  /**
   * Validate and canonicalise wire levels.
   *
   * `readDecimal` refuses a JSON number here rather than downstream, and
   * `formatAmount` makes the price key canonical so `"30000"` and `"30000.0"`
   * cannot become two levels at one price. Quantity `'0'` is preserved: in a
   * delta it is the ONLY encoding of removal, and dropping it would leave
   * phantom liquidity behind.
   */
  #wire(levels: readonly (readonly [string, string])[], side: 'bids' | 'asks'): WireLevel[] {
    return levels.map(([price, quantity]) => {
      const parsedPrice = readDecimal(price, this.venueId, `${side}.price`);
      if (parsedPrice <= 0n) {
        throw new Error(`${this.venueId}.${side}: delta carries a non-positive price "${String(price)}"`);
      }
      const parsedQuantity = readDecimal(quantity, this.venueId, `${side}.quantity`);
      return [formatAmount(parsedPrice), formatAmount(parsedQuantity)] as WireLevel;
    });
  }

  #bufferDelta(delta: VenueBookDelta): void {
    this.#buffer.push(delta);
    while (this.#buffer.length > this.#options.maxBufferedDeltas) {
      this.#buffer.shift();
      this.#droppedFromBuffer += 1;
    }
  }

  #desync(reason: DesyncReason, detail: string, delta: VenueBookDelta): TrackerOutcome {
    this.#state = 'desynced';
    this.#resyncs += 1;
    this.#lastDesync = { reason, detail, at: delta.observedAt, sequence: this.sequence };
    // The book is withheld from here on, but the stream keeps arriving. Buffer
    // it so the fresh snapshot can join without a second round trip.
    this.#buffer = [];
    this.#bufferDelta(delta);
    return { kind: 'desynced', state: 'desynced', reason, detail };
  }
}
