import { parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { applyMark } from './trailing-stop.js';
import type { BookState, CancelledRef, Fill, MarketId, TriggerFact, TriggerOutcome } from './types.js';
import type { JournalRecord } from './journal-codec.js';
import { fromWire, fromWireAmend } from './journal-wire.js';

// ── Replay (§5.4) ────────────────────────────────────────────────────

/**
 * Rebuild every book from scratch.
 *
 * There is no state in here beyond the books themselves and nothing consulted
 * but the records, so `replay(records)` twice is `replay(records)` twice — the
 * property §5.4 asks to be proven.
 */
function journalClock(at: string): Date | null {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function applySessionDead(books: Map<MarketId, OrderBook>, sessionId: string): void {
  for (const marketId of [...books.keys()]) {
    const book = books.get(marketId);
    if (!book) continue;
    book.cancelSession(sessionId);
    if (book.isNeverPrintedEmpty) books.delete(marketId);
  }
}

function submitSessionDead(order: { readonly sessionId?: string }, dead: ReadonlySet<string>): boolean {
  const sessionId = order.sessionId;
  return sessionId !== undefined && sessionId.length > 0 && dead.has(sessionId);
}

export interface ReplayFill {
  readonly marketId: MarketId;
  readonly at: string;
  readonly fill: Fill;
}

/** A hold_unconfirmed cancel. Re-announced on the next boot with the same sequence key. */
export interface ReplayHoldCancel {
  readonly marketId: MarketId;
  readonly cancellation: CancelledRef;
}

/** A stop that fired. Re-announced on the next boot with the same sequence key, like the fills it led to. */
export interface ReplayTrigger {
  readonly marketId: MarketId;
  readonly at: string;
  readonly orderId: string;
  readonly sequence: number;
  readonly trigger: TriggerFact;
}

function collectFills(
  marketId: MarketId,
  at: string,
  result: { readonly fills: readonly Fill[]; readonly triggered: readonly TriggerOutcome[] },
  into: ReplayFill[],
  triggers: ReplayTrigger[],
): void {
  const chunk: ReplayFill[] = [];
  // An amend that fires its own stop reports those fills twice (on the result and on its trigger outcome): one each.
  // (the same objects, so identity is the test: one sequence can carry several fills, as an exercise does).
  const seen = new Set<Fill>();
  const add = (fill: Fill): void => {
    if (seen.has(fill)) return;
    seen.add(fill);
    chunk.push({ marketId, at, fill });
  };
  for (const fill of result.fills) add(fill);
  for (const triggered of result.triggered) {
    if (triggered.trigger) {
      triggers.push({ marketId, at, orderId: triggered.orderId, sequence: triggered.sequence, trigger: triggered.trigger });
    }
    for (const fill of triggered.fills) add(fill);
  }
  chunk.sort((a, b) => a.fill.sequence - b.fill.sequence);
  into.push(...chunk);
}

/**
 * Rebuild books from journalled inputs and collect the fills that replay
 * produced. Fills are matcher outputs of those inputs — never invented rows.
 */
export function replayJournal(records: readonly JournalRecord[]): {
  readonly books: Map<MarketId, OrderBook>;
  readonly fills: readonly ReplayFill[];
  readonly holdCancels: readonly ReplayHoldCancel[];
  readonly triggers: readonly ReplayTrigger[];
} {
  const books = new Map<MarketId, OrderBook>();
  const fills: ReplayFill[] = [];
  const holdCancels: ReplayHoldCancel[] = [];
  const triggers: ReplayTrigger[] = [];
  const deadSessions = new Set<string>();

  const bookFor = (marketId: MarketId): OrderBook => {
    let book = books.get(marketId);
    if (!book) {
      book = new OrderBook(marketId);
      books.set(marketId, book);
    }
    return book;
  };

  for (const record of records) {
    if (record.kind === 'session_dead') {
      deadSessions.add(record.sessionId);
      applySessionDead(books, record.sessionId);
      continue;
    }
    if (record.kind === 'submit') {
      if (submitSessionDead(record.order, deadSessions)) continue;
      const book = bookFor(record.marketId);
      const result = book.submit(fromWire(record.order), journalClock(record.at));
      collectFills(record.marketId, record.at, result, fills, triggers);
      // Reject-only and IOC/market-remainder opens must not survive replay
      // either — same honesty as live dropIfNeverTraded (print or rest, or drop).
      if (book.isNeverPrintedEmpty) books.delete(record.marketId);
      continue;
    }
    // Halt/resume/reduce-only/post-only/prelaunch/expire/delist is engine control state, not a book. MatchingEngine.recover
    // rebuilds it separately so replay does not treat it as a cancel.
    if (
      record.kind === 'halt' ||
      record.kind === 'resume' ||
      record.kind === 'reduce_only' ||
      record.kind === 'resume_reduce_only' ||
      record.kind === 'post_only' ||
      record.kind === 'resume_post_only' ||
      record.kind === 'prelaunch' ||
      record.kind === 'open' ||
      record.kind === 'expire' ||
      record.kind === 'delist' ||
      record.kind === 'maintenance' ||
      record.kind === 'end_maintenance' ||
      record.kind === 'halt_all' ||
      record.kind === 'resume_all' ||
      record.kind === 'split_brain' ||
      record.kind === 'clear_split_brain' ||
      record.kind === 'in_flight' ||
      record.kind === 'open_surveillance' ||
      record.kind === 'spread_list'
    )
      continue;
    /**
     * CANCEL/AMEND MUST NOT OPEN A MARKET ON REPLAY. Live cancel/amend no
     * longer journals unknown markets, but journals written before that fix
     * still contain cancel-only phantoms. Replaying those through bookFor
     * re-invented empty markets forever. Cancel/amend/mass-cancel is a no-op when the
     * market never submitted. in_flight is engine control — replay does not
     * invent a cancel or a second rest from the flag. open_surveillance is
     * evidence — replay does not invent a cancel or a fine from it.
     */
    const existing = books.get(record.marketId);
    if (!existing) continue;
    if (record.kind === 'amend') {
      const result = existing.amend(fromWireAmend(record.orderId, record.expectedVersion, record.patch), journalClock(record.at));
      collectFills(record.marketId, record.at, result, fills, triggers);
      if (existing.isNeverPrintedEmpty) books.delete(record.marketId);
      continue;
    }
    if (record.kind === 'mark') {
      applyMark(existing, parseAmount(record.mark));
      continue;
    }
    if (record.kind === 'mass_cancel') {
      existing.cancelAccount(record.accountId, record.side ?? null);
      if (existing.isNeverPrintedEmpty) books.delete(record.marketId);
      continue;
    }
    if (record.kind === 'cancel') {
      const result = existing.cancel(record.orderId, record.reason ?? 'requested');
      if (record.reason === 'hold_unconfirmed' && result.cancellation) {
        holdCancels.push({ marketId: record.marketId, cancellation: result.cancellation });
      }
    }
  }

  return { books, fills, holdCancels, triggers };
}

export function replay(records: readonly JournalRecord[]): Map<MarketId, OrderBook> {
  return replayJournal(records).books;
}

/**
 * Replay from a snapshot forward. §5.1 snapshots every N events so recovery
 * does not have to replay from the beginning of time.
 */
export function replayFrom(snapshot: EngineSnapshot, records: readonly JournalRecord[]): Map<MarketId, OrderBook> {
  const books = restoreAll(snapshot);
  const tail = records.filter((r) => r.seq > snapshot.journalSeq);
  // A session_dead at or before journalSeq is not in the tail. Seed it so a
  // later submit is skipped the same way a full replay skips it. A session_dead
  // in the tail still joins this set and kills submits after it.
  const deadSessions = new Set<string>();
  for (const sessionId of snapshot.deadSessions ?? []) {
    if (sessionId.length > 0) deadSessions.add(sessionId);
  }

  for (const record of tail) {
    if (record.kind === 'session_dead') {
      deadSessions.add(record.sessionId);
      applySessionDead(books, record.sessionId);
      continue;
    }
    if (record.kind === 'submit') {
      if (submitSessionDead(record.order, deadSessions)) continue;
      let book = books.get(record.marketId);
      if (!book) {
        book = new OrderBook(record.marketId);
        books.set(record.marketId, book);
      }
      book.submit(fromWire(record.order), journalClock(record.at));
      if (book.isNeverPrintedEmpty) books.delete(record.marketId);
      continue;
    }
    if (
      record.kind === 'halt' ||
      record.kind === 'resume' ||
      record.kind === 'reduce_only' ||
      record.kind === 'resume_reduce_only' ||
      record.kind === 'post_only' ||
      record.kind === 'resume_post_only' ||
      record.kind === 'prelaunch' ||
      record.kind === 'open' ||
      record.kind === 'expire' ||
      record.kind === 'delist' ||
      record.kind === 'maintenance' ||
      record.kind === 'end_maintenance' ||
      record.kind === 'halt_all' ||
      record.kind === 'resume_all' ||
      record.kind === 'split_brain' ||
      record.kind === 'clear_split_brain' ||
      record.kind === 'in_flight' ||
      record.kind === 'open_surveillance' ||
      record.kind === 'spread_list'
    )
      continue;
    // Same rule as full replay: cancel/amend/mass-cancel never invents a market.
    const existing = books.get(record.marketId);
    if (!existing) continue;
    if (record.kind === 'amend') {
      existing.amend(fromWireAmend(record.orderId, record.expectedVersion, record.patch), journalClock(record.at));
      if (existing.isNeverPrintedEmpty) books.delete(record.marketId);
      continue;
    }
    if (record.kind === 'mark') {
      applyMark(existing, parseAmount(record.mark));
      continue;
    }
    if (record.kind === 'mass_cancel') {
      existing.cancelAccount(record.accountId, record.side ?? null);
      if (existing.isNeverPrintedEmpty) books.delete(record.marketId);
      continue;
    }
    existing.cancel(record.orderId);
  }

  return books;
}

// ── Snapshots (§5.1) ────────────────────────────────────────────────

export interface EngineSnapshot {
  /** Journal position this snapshot is consistent with — replay resumes at `seq > journalSeq`. */
  readonly journalSeq: number;
  readonly books: readonly BookState[];
  /** Session ids already dead at `journalSeq`. Tail replay starts from this set. */
  readonly deadSessions?: readonly string[];
}

export function snapshot(book: OrderBook): BookState {
  return book.toState();
}

export function restore(state: BookState): OrderBook {
  return OrderBook.fromState(state);
}

/** Market ids are sorted so the snapshot of a given state is one string, not one per Map insertion order. */
export function snapshotAll(
  books: ReadonlyMap<MarketId, OrderBook>,
  journalSeq: number,
  deadSessionIds: ReadonlySet<string> | readonly string[] = [],
): EngineSnapshot {
  const ids = [...books.keys()].sort();
  const deadSessions = [...new Set(deadSessionIds)].filter((id) => id.length > 0).sort();
  return { journalSeq, books: ids.map((id) => (books.get(id) as OrderBook).toState()), deadSessions };
}

export function restoreAll(snap: EngineSnapshot): Map<MarketId, OrderBook> {
  const books = new Map<MarketId, OrderBook>();
  for (const state of snap.books) books.set(state.marketId, OrderBook.fromState(state));
  return books;
}

/**
 * The canonical string form of a whole engine's books — what §5.4's determinism
 * test compares. Sorted by market id, because "two replays are equal" must not
 * depend on which market happened to receive its first order first.
 */
export function serializeBooks(books: ReadonlyMap<MarketId, OrderBook>): string {
  const ids = [...books.keys()].sort();
  return JSON.stringify(ids.map((id) => (books.get(id) as OrderBook).toState()));
}
