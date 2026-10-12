import type { Amount } from '@intafaced/ledger-client/money';
import type { PriceLevel } from './decimal.js';

/**
 * THE SEQUENCED BOOK CONTRACT.
 *
 * ── The failure this shape exists to make impossible ────────────────────────
 *
 * A websocket depth stream that silently drops one update leaves a book that
 * answers every question instantly, renders perfectly, and is WRONG. There is
 * no symptom. No exception, no gap in a log, no latency spike — just a price
 * that was never on the venue, handed to a router that trusts it. The first
 * anyone knows is a fill at a level nobody was offering.
 *
 * The only defence is arithmetic: the venue numbers its updates, and we check
 * that the numbers are contiguous before we believe them. That check has to be
 * mandatory, not advisory, which is why `sequence` below is not optional and
 * why `sequenced` is a field a consumer can branch on rather than something to
 * be inferred from a zero.
 *
 * ── Why `sequenced: false` is honest rather than a loophole ─────────────────
 *
 * Some venues genuinely publish no sequence — an AMM read at a block height,
 * an OTC desk quoting on request. A book from one of those cannot be gap-
 * checked, and pretending otherwise by generating a counter of our own would be
 * the worst outcome available: a consumer would believe it could detect a gap
 * on a feed that gives it no way to. So the field says which it is, and a
 * consumer that requires gap detection filters on it.
 *
 * ── Absolute levels, always ─────────────────────────────────────────────────
 *
 * A delta carries the NEW TOTAL at a price, never a change to it, and quantity
 * zero is the only encoding of removal. Both learned the hard way by every
 * exchange that did it the other way — see `packages/market-data/src/depth.ts`,
 * which is this repo's prior art and which the fabric's tracker delegates to
 * rather than reimplementing.
 */

/** The venue's own numbering of one update, or of one contiguous batch of them. */
export interface SequenceStamp {
  /**
   * First update id contained in this message.
   *
   * Equal to `lastSequence` on a venue that emits one update per message. A
   * venue that coalesces several updates into one frame publishes a range, and
   * a consumer that assumed `last === first + 0` would call every batched frame
   * a gap and resnapshot forever.
   */
  readonly firstSequence: number;
  /** Last update id contained in this message; the book's sequence once applied. */
  readonly lastSequence: number;
}

/** A full book, as read from the venue at a moment. */
export interface VenueBookSnapshot {
  readonly venueId: string;
  readonly symbol: string;
  /** Descending by price. */
  readonly bids: readonly PriceLevel[];
  /** Ascending by price. */
  readonly asks: readonly PriceLevel[];
  /**
   * The venue's sequence this snapshot is current as of.
   *
   * `-1` when `sequenced` is false. Not `0`: zero is a legitimate first
   * sequence on a freshly-listed market, and a sentinel that collides with a
   * real value is how "no sequence" becomes "sequence zero" in a comparison.
   */
  readonly sequence: number;
  /** False when this venue publishes no update numbering at all. See the header. */
  readonly sequenced: boolean;
  /**
   * When THIS PROCESS finished reading it. Our clock, not theirs.
   *
   * NOT DECORATION. This field is the only thing that makes a downstream
   * staleness check mean anything, and a consumer that reads `bids` and `asks`
   * and drops it has no age left to check: the only clock it can stamp with is
   * its own at the moment it asked, which makes every price it derives exactly
   * zero seconds old and every age limit it owns unreachable.
   *
   * That is not hypothetical. `svc-trade`'s futures mark did precisely this —
   * read the book, discarded this field, stamped the caller's clock — and a
   * four-hour-old external book cleared a sixty-second liquidation gate as a
   * result (`services/svc-trade/src/futures/mark-observed-at.test.ts`).
   *
   * So: carry it. Anything deriving a price, a mid or a mark from a snapshot
   * must propagate this value to whatever judges that price's age, and must
   * REFUSE rather than substitute a clock of its own when it is missing.
   */
  readonly observedAt: Date;
}

/**
 * One incremental update. Levels are ABSOLUTE totals; quantity `'0'` removes.
 *
 * Levels are wire-shaped (`[string, string]`) rather than parsed here because
 * the removal encoding differs from the snapshot one — `readLevels` drops zero
 * quantities, and a delta must keep them. Parsing happens inside the tracker,
 * where both readings are in view at once.
 */
export interface VenueBookDelta {
  readonly venueId: string;
  readonly symbol: string;
  readonly sequence: SequenceStamp;
  readonly bids: readonly (readonly [price: string, quantity: string])[];
  readonly asks: readonly (readonly [price: string, quantity: string])[];
  readonly observedAt: Date;
}

/**
 * Whether the local copy of a venue's book can be trusted right now.
 *
 * `desynced` is not an error state to be retried past — it is a book that must
 * not be served. A fabric that answered from a desynced book "because it is
 * probably still close" would be doing exactly the thing this module exists to
 * prevent, only deliberately.
 */
export type BookSyncState =
  /** Streaming, but no snapshot yet. Deltas are being buffered. */
  | 'awaiting-snapshot'
  /** Snapshot applied and every delta since has been contiguous. Servable. */
  | 'live'
  /** A gap was detected. NOT servable until a fresh snapshot lands. */
  | 'desynced';

export interface BookTop {
  readonly bestBid: Amount | null;
  readonly bestAsk: Amount | null;
  readonly bestBidQty: Amount | null;
  readonly bestAskQty: Amount | null;
  /** `null` when either side is empty — a one-sided book has no spread. */
  readonly spread: Amount | null;
  /**
   * `(bestBid + bestAsk) / 2` when the book is not crossed and that half is
   * not zero. `null` on a one-sided book, a crossed book, or a half of zero.
   *
   * The figure cross-checking compares venues on. Deliberately not a
   * last-traded price: a stale last-trade on a thin venue is the single most
   * misleading number in market data, because it is a real print from a market
   * that has since moved.
   */
  readonly mid: Amount | null;
}

/** Top of a parsed book. Levels arrive sorted, so the top is the first of each. */
export function topOfBook(bids: readonly PriceLevel[], asks: readonly PriceLevel[]): BookTop {
  const bid = bids[0] ?? null;
  const ask = asks[0] ?? null;
  const bestBid = bid?.[0] ?? null;
  const bestAsk = ask?.[0] ?? null;

  // Integer halving. The lost wei is irrelevant to a comparison and the
  // alternative — carrying a fraction — would put a float in a price.
  // A crossed book (bid >= ask) is a wrong copy. A half of 0n is not a price.
  let spread: Amount | null = null;
  let mid: Amount | null = null;
  if (bestBid !== null && bestAsk !== null) {
    spread = bestAsk - bestBid;
    const half = (bestBid + bestAsk) / 2n;
    if (bestBid < bestAsk && half !== 0n) mid = half;
  }

  return {
    bestBid,
    bestAsk,
    bestBidQty: bid?.[1] ?? null,
    bestAskQty: ask?.[1] ?? null,
    spread,
    mid,
  };
}

/**
 * Mid of a snapshot, or `null`.
 *
 * Empty, one-sided, crossed, and missing books have no mid, and neither does
 * a book whose integer half is zero. This is the only derived price this
 * package will mint from a book: never a last-trade, never zero, never a
 * previously-seen number. Callers that need a price when this is `null` must
 * refuse, not invent.
 */
export function midFromSnapshot(snapshot: VenueBookSnapshot | null | undefined): Amount | null {
  if (!snapshot) return null;
  return topOfBook(snapshot.bids, snapshot.asks).mid;
}

/**
 * A book is crossed when the best bid is at or above the best ask.
 *
 * On one venue that is impossible and means our copy is wrong — usually a
 * missed removal, which is exactly what a dropped delta produces. Worth
 * checking even with sequence numbers, because it catches the case sequence
 * numbers cannot: a venue whose own numbering is correct and whose payload is
 * not.
 */
export function isCrossed(top: BookTop): boolean {
  return top.bestBid !== null && top.bestAsk !== null && top.bestBid >= top.bestAsk;
}
