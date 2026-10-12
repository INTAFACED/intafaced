import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { CaptureLog, bookLevelsFromCapture, type CaptureRecord, type VenueConnection } from '@intafaced/connect-data-lake';

/**
 * INCREMENTAL DEPTH (§5.2 ws.gateway).
 *
 * A trading terminal that re-renders a full order book on every tick is a demo.
 * A real one takes one snapshot and applies a stream of deltas — and that is
 * where order books quietly go wrong.
 *
 * ── The failure this module exists to make impossible ───────────────────────
 *
 * Every incremental book has the same hazard: a delta that is applied twice,
 * applied out of order, or applied on top of a gap. None of those crash. The
 * book simply stops matching the exchange's, and the first the user knows is a
 * price that was never there. Binance's depth stream is notorious for exactly
 * this — the sequence bookkeeping is on the client, and clients get it wrong.
 *
 * So the sequence check is not advisory here. `applyDelta` REFUSES a delta that
 * does not continue from the book it is given, and returns a typed `gap` result
 * telling the caller to resnapshot. A book cannot silently drift, because the
 * only function that can mutate it will not do so out of order.
 *
 * ── Why levels are absolute, not relative ───────────────────────────────────
 *
 * A delta carries the NEW TOTAL at a price, never a change to it. Two reasons,
 * both learned the hard way by every exchange that did it the other way:
 *
 *   · A relative delta applied twice corrupts the level. An absolute one
 *     applied twice is idempotent — worth having even with sequence checks,
 *     because the belt matters exactly when the braces have failed.
 *   · A relative delta requires the level to already exist. An absolute one
 *     carries its own truth, so a book can be repaired level by level.
 *
 * Quantity `'0'` means the level is gone. That is the only encoding of removal:
 * an absent level in a delta means UNCHANGED, never removed, and conflating
 * those two is how a book grows phantom liquidity.
 *
 * ── Money ───────────────────────────────────────────────────────────────────
 *
 * Prices and quantities are decimal strings on the wire and scaled bigint in
 * memory. Never `number`: a float sums 0.1 + 0.2 to something that is not 0.3,
 * and an order book is nothing but sums.
 */

/**
 * One side of a book: canonical price → total quantity resting at that price.
 * Keys are `formatAmount(parseAmount(wire))`, never the raw wire spelling —
 * `'100'` and `'100.0'` are one level.
 */
export type DepthSide = ReadonlyMap<string, Amount>;

export interface DepthBook {
  readonly marketId: string;
  /** Engine sequence this book is current as of. */
  readonly sequence: number;
  readonly bids: DepthSide;
  readonly asks: DepthSide;
}

/** A price level on the wire. `['30000.5', '0']` removes the level. */
export type WireLevel = readonly [price: string, quantity: string];

export interface DepthSnapshot {
  readonly type: 'snapshot';
  readonly marketId: string;
  readonly sequence: number;
  readonly bids: readonly WireLevel[];
  readonly asks: readonly WireLevel[];
}

export interface DepthDelta {
  readonly type: 'delta';
  readonly marketId: string;
  /**
   * The sequence this delta expects the book to be at. A book at any other
   * sequence must not apply it — that is the whole safety property.
   */
  readonly fromSequence: number;
  /** The sequence the book is at once applied. */
  readonly sequence: number;
  readonly bids: readonly WireLevel[];
  readonly asks: readonly WireLevel[];
}

export type DepthMessage = DepthSnapshot | DepthDelta;

export function emptyBook(marketId: string): DepthBook {
  return { marketId, sequence: -1, bids: new Map(), asks: new Map() };
}

/** Map key for a wire price: the canonical Amount string, not the raw spelling. */
function priceKey(wirePrice: string): string {
  return formatAmount(parseAmount(wirePrice));
}

/**
 * Same `invalid-qty` refusal `applyDelta` returns. Not a `DepthBook`:
 * no bids, asks, or book.
 */
export type InvalidQtyRefusal = {
  readonly ok: false;
  readonly reason: 'invalid-qty';
  readonly expected: number;
  readonly got: number;
};

type LevelQty<L> = L extends readonly [unknown, infer Q] ? Q : never;

type SideQty<Side> = Side extends readonly (infer L)[] ? LevelQty<L> : never;

type SnapshotQty<S> = S extends { readonly bids: infer B; readonly asks: infer A } ? SideQty<B> | SideQty<A> : never;

/**
 * Wide `string` is not a negative literal, so a `DepthSnapshot` stays a
 * `DepthBook`. A literal such as `"-1"` is not.
 */
type NegativeLiteralQty<Q> = string extends Q ? false : Q extends `-${infer Rest}` ? (Rest extends '' ? false : true) : false;

type SnapshotHasNegativeQty<S> = true extends NegativeLiteralQty<SnapshotQty<S>> ? true : false;

/**
 * What callers compile against. Valid snapshot → `DepthBook`.
 * A negative qty literal → `InvalidQtyRefusal`, which is not a `DepthBook`.
 */
export type SnapshotBookResult<S extends DepthSnapshot> = SnapshotHasNegativeQty<S> extends true ? InvalidQtyRefusal : DepthBook;

/** `null` means a negative qty refused the side. Zero still deletes; it is not garbage. */
function sideFromWire(levels: readonly WireLevel[]): Map<string, Amount> | null {
  const side = new Map<string, Amount>();
  for (const [price, qty] of levels) {
    const amount = parseAmount(qty);
    const key = priceKey(price);
    // Last write wins when the same canonical price appears twice. A later
    // qty 0 at that key must retract the earlier rest — dropping only `> 0`
    // would leave the first write as phantom liquidity.
    // Negative is not that delete: one bad level refuses the side, so a
    // snapshot cannot quietly drop it and return a partial book.
    if (amount > 0n) side.set(key, amount);
    else if (amount === 0n) side.delete(key);
    else return null;
  }
  return side;
}

function invalidQtyRefusal(sequence: number): InvalidQtyRefusal {
  return { ok: false, reason: 'invalid-qty', expected: sequence, got: sequence };
}

function isInvalidQtyRefusal(err: unknown): err is InvalidQtyRefusal {
  if (typeof err !== 'object' || err === null) return false;
  const refusal = err as Partial<InvalidQtyRefusal>;
  return refusal.ok === false && refusal.reason === 'invalid-qty';
}

/**
 * Valid snapshot → `DepthBook`. A negative qty throws `InvalidQtyRefusal`
 * instead of returning a book. Callers bind this result as a `DepthBook`
 * and do not narrow, so a returned refusal would be installed.
 * A snapshot has no prior sequence, so `expected` and `got` are that sequence.
 * A negative qty literal's type is `InvalidQtyRefusal`, not a `DepthBook`.
 */
export function bookFromSnapshot<const S extends DepthSnapshot>(snapshot: S): SnapshotBookResult<S>;
export function bookFromSnapshot(snapshot: DepthSnapshot): DepthBook {
  const bids = sideFromWire(snapshot.bids);
  const asks = sideFromWire(snapshot.asks);
  if (bids === null || asks === null) {
    // Throw, do not return. A DepthBook binding must not receive this.
    throw invalidQtyRefusal(snapshot.sequence);
  }
  return {
    marketId: snapshot.marketId,
    sequence: snapshot.sequence,
    bids,
    asks,
  };
}

export type ApplyResult =
  | { readonly ok: true; readonly book: DepthBook }
  /**
   * The delta does not continue this book. The caller must re-snapshot; it must
   * NOT apply the delta anyway, and it must not keep serving the stale book as
   * though it were current.
   */
  | { readonly ok: false; readonly reason: 'gap'; readonly expected: number; readonly got: number }
  | { readonly ok: false; readonly reason: 'stale'; readonly expected: number; readonly got: number }
  | { readonly ok: false; readonly reason: 'wrong-market'; readonly expected: string; readonly got: string }
  /**
   * A negative absolute qty is garbage. Zero remains delete.
   * `expected` is the book seq we kept; `got` is the delta seq we refused.
   */
  | InvalidQtyRefusal;

function applySide(current: DepthSide, levels: readonly WireLevel[]): Map<string, Amount> {
  const next = new Map(current);
  for (const [price, qty] of levels) {
    const amount = parseAmount(qty);
    const key = priceKey(price);
    // Zero is removal. An ABSENT price is unchanged — the two are different
    // statements and treating them alike leaves phantom liquidity behind.
    // Negative quantity is garbage: it must not rest, and it is not a delete.
    if (amount === 0n) next.delete(key);
    else if (amount > 0n) next.set(key, amount);
  }
  return next;
}

/**
 * Apply a delta, or refuse and say why.
 *
 * Returns a result rather than throwing: a gap is an expected condition on a
 * lossy transport, not an exception. A caller that must handle it is more
 * likely to than one that may catch it.
 */
export function applyDelta(book: DepthBook, delta: DepthDelta): ApplyResult {
  if (delta.marketId !== book.marketId) {
    return { ok: false, reason: 'wrong-market', expected: book.marketId, got: delta.marketId };
  }

  // Already applied. Re-delivery is normal on a reconnect, and treating it as a
  // gap would send the client into a resnapshot loop.
  if (delta.sequence <= book.sequence) {
    return { ok: false, reason: 'stale', expected: book.sequence + 1, got: delta.sequence };
  }

  if (delta.fromSequence !== book.sequence) {
    return { ok: false, reason: 'gap', expected: book.sequence, got: delta.fromSequence };
  }

  if (hasNegativeQty(delta.bids) || hasNegativeQty(delta.asks)) {
    return { ok: false, reason: 'invalid-qty', expected: book.sequence, got: delta.sequence };
  }

  return {
    ok: true,
    book: {
      marketId: book.marketId,
      sequence: delta.sequence,
      bids: applySide(book.bids, delta.bids),
      asks: applySide(book.asks, delta.asks),
    },
  };
}

function hasNegativeQty(levels: readonly WireLevel[]): boolean {
  for (const [, qty] of levels) {
    if (parseAmount(qty) < 0n) return true;
  }
  return false;
}

function diffSide(prev: DepthSide, next: DepthSide): WireLevel[] {
  const out: WireLevel[] = [];

  for (const [price, qty] of next) {
    if (prev.get(price) !== qty) out.push([price, formatAmount(qty)]);
  }
  // Removals: present before, absent now.
  for (const price of prev.keys()) {
    if (!next.has(price)) out.push([price, '0']);
  }

  return out;
}

/**
 * Compute the delta that turns `prev` into `next`.
 *
 * The server side. `applyDelta(prev, diffDepth(prev, next))` must equal `next`
 * exactly — a property the tests assert over generated books rather than over
 * examples, because the interesting cases are the ones nobody thinks to write.
 */
export function diffDepth(prev: DepthBook, next: DepthBook): DepthDelta {
  return {
    type: 'delta',
    marketId: next.marketId,
    fromSequence: prev.sequence,
    sequence: next.sequence,
    bids: diffSide(prev.bids, next.bids),
    asks: diffSide(prev.asks, next.asks),
  };
}

/**
 * Best bid / best ask, and the spread between them.
 *
 * Sorted here rather than kept sorted, because a book is written far more often
 * than its top is read, and the map is the shape that makes application O(1).
 * If profiling ever says otherwise this is the place to put a heap — the
 * interface would not change.
 */
export interface BookTop {
  readonly bestBid: Amount | null;
  readonly bestAsk: Amount | null;
  readonly bestBidQty: Amount | null;
  readonly bestAskQty: Amount | null;
  /** `null` when either side is empty — a one-sided book has no spread. */
  readonly spread: Amount | null;
}

export function bookTop(book: DepthBook): BookTop {
  let bestBid: Amount | null = null;
  let bestAsk: Amount | null = null;
  let bestBidQty: Amount | null = null;
  let bestAskQty: Amount | null = null;

  for (const [price, qty] of book.bids) {
    const p = parseAmount(price);
    if (bestBid === null || p > bestBid) {
      bestBid = p;
      bestBidQty = qty;
    }
  }
  for (const [price, qty] of book.asks) {
    const p = parseAmount(price);
    if (bestAsk === null || p < bestAsk) {
      bestAsk = p;
      bestAskQty = qty;
    }
  }

  return {
    bestBid,
    bestAsk,
    bestBidQty,
    bestAskQty,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
  };
}

/**
 * Sorted levels for rendering, with a running cumulative total.
 *
 * The cumulative column is what a depth ladder shades, and computing it here
 * rather than in the component keeps it out of a render loop and — more
 * importantly — keeps it in bigint. A component that accumulated with `+` on
 * numbers would be wrong in the last decimal place on every row below the top.
 */
export interface LadderRow {
  readonly price: Amount;
  readonly quantity: Amount;
  readonly cumulative: Amount;
}

export function ladder(book: DepthBook, side: 'bids' | 'asks', limit = 20): LadderRow[] {
  const entries = [...book[side].entries()].map(([price, quantity]) => ({ price: parseAmount(price), quantity }));

  // Bids descend, asks ascend — both away from the spread.
  entries.sort((a, b) =>
    side === 'bids' ? (b.price > a.price ? 1 : b.price < a.price ? -1 : 0) : a.price > b.price ? 1 : a.price < b.price ? -1 : 0,
  );

  const rows: LadderRow[] = [];
  let cumulative = 0n;
  for (const entry of entries.slice(0, limit)) {
    cumulative += entry.quantity;
    rows.push({ price: entry.price, quantity: entry.quantity, cumulative });
  }
  return rows;
}

export interface VenueDepthSnapshotIngest {
  readonly venueId: string;
  readonly marketId: string;
  readonly connection: VenueConnection;
  /** Missing / null when the adapter returned no book. Prefer absent over silent empty. */
  readonly snapshot?: DepthSnapshot | null;
}

export interface VenueDepthIngestResult {
  readonly record: CaptureRecord;
  /** Null when capture is absent — never a synthetic empty DepthBook. */
  readonly book: DepthBook | null;
}

/**
 * Snapshot ingest with a venue id. Unconnected / missing books write an absent
 * capture hole and return `book: null`. A connected empty snapshot is measured
 * empty and becomes a real (empty) DepthBook.
 */
export function ingestVenueDepthSnapshot(lake: CaptureLog, input: VenueDepthSnapshotIngest): VenueDepthIngestResult {
  const snapshot = input.snapshot ?? null;
  const record = lake.captureBook({
    venueId: input.venueId,
    marketId: snapshot?.marketId ?? input.marketId,
    connection: input.connection,
    snapshot: snapshot ? { sequence: snapshot.sequence, bids: snapshot.bids, asks: snapshot.asks } : null,
  });
  if (bookLevelsFromCapture(record) === null || snapshot === null) {
    return { record, book: null };
  }
  try {
    return { record, book: bookFromSnapshot(snapshot) };
  } catch (err) {
    // Same refusal as applyDelta: do not publish a book that dropped a negative qty.
    if (isInvalidQtyRefusal(err)) return { record, book: null };
    throw err;
  }
}

export interface VenueDepthDeltaIngest {
  readonly venueId: string;
  readonly marketId: string;
  readonly connection: VenueConnection;
  readonly book?: DepthBook | null;
  readonly delta?: DepthDelta | null;
}

export type VenueDeltaIngestResult =
  | { readonly record: CaptureRecord; readonly apply: ApplyResult }
  | { readonly record: CaptureRecord; readonly apply: { readonly ok: false; readonly reason: 'absent' } };

/**
 * Delta ingest. A missing book or unwired venue is an absent hole — the delta
 * is not applied onto an invented empty book. A refused delta is the same
 * hole: snapshot null, not a measured copy of the book it was refused against.
 */
export function ingestVenueDepthDelta(lake: CaptureLog, input: VenueDepthDeltaIngest): VenueDeltaIngestResult {
  const book = input.book ?? null;
  const delta = input.delta ?? null;
  if (input.connection !== 'connected' || book === null || delta === null) {
    const record = lake.captureBook({
      venueId: input.venueId,
      marketId: delta?.marketId ?? book?.marketId ?? input.marketId,
      connection: input.connection === 'connected' ? 'connected' : input.connection,
      snapshot: null,
    });
    return { record, apply: { ok: false, reason: 'absent' } };
  }
  const apply = applyDelta(book, delta);
  const record = lake.captureBook({
    venueId: input.venueId,
    marketId: book.marketId,
    connection: 'connected',
    snapshot: apply.ok
      ? {
          sequence: apply.book.sequence,
          bids: [...apply.book.bids.entries()].map(([price, qty]) => [price, formatAmount(qty)] as const),
          asks: [...apply.book.asks.entries()].map(([price, qty]) => [price, formatAmount(qty)] as const),
        }
      : null,
  });
  return { record, apply };
}
