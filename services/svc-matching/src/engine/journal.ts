import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import type { MarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { OrderBook } from './book.js';
import type { BookState, EngineAmend, EngineOrder, EngineOrderType, MarketId, OrderId, OrderSide, TimeInForce } from './types.js';

/**
 * THE ENGINE JOURNAL (§5.1).
 *
 * "Every input persisted to an append-only engine_journal before processing →
 *  full replay = current book state (recovery guarantee)."
 *
 * Two properties do all the work:
 *
 *   1. INPUTS ONLY. The journal records what was asked, never what happened.
 *      If it recorded outcomes, a replay would be a transcript rather than a
 *      proof — and a bug in the matcher would replay perfectly while the book
 *      stayed wrong. Replaying inputs through the same matcher is what makes
 *      the state verifiable.
 *
 *   2. BEFORE PROCESSING. The record is durable before the book moves. A crash
 *      between the two costs a **replay of that input into an empty book**
 *      (recovery rebuilds once from the journal; it does not re-emit bus
 *      events). Safety is **not** "duplicate_order_id on live re-submit" —
 *      that guard only covers **still-live** resting/stop ids (README).
 *      Never-rests markets and fully filled ids are reusable by design; a
 *      second live submit of the same id after the order is gone is a new
 *      trade-side concern, not journal crash safety. A crash the other way
 *      (book moved before journal) would cost a fill nobody can reconstruct.
 *
 * Amounts are decimal strings on disk. A journal is read years after it is
 * written, by processes that may not share this build — a scaled bigint is our
 * private representation, not an archival format.
 */

export interface WireOrder {
  readonly orderId: OrderId;
  readonly accountId: string;
  readonly type: EngineOrderType;
  readonly side: OrderSide;
  readonly qty: string;
  readonly price: string | null;
  readonly stopPrice: string | null;
  readonly tif: TimeInForce;
  readonly ocoSiblingId?: string;
  readonly expireAt?: string;
  readonly reduceOnly?: boolean;
  /** Exact PX-S01 admission evidence for new HTTP submissions. */
  readonly lifecycleProof?: MarketLifecycleAdmissionProof;
}

export interface WireAmendPatch {
  readonly qty?: string;
  readonly price?: string;
  readonly stopPrice?: string;
  readonly tif?: TimeInForce;
}

export type JournalCommand =
  | {
      readonly kind: 'submit';
      readonly marketId: MarketId;
      /** Wall clock at admission. Journalled because event payloads carry it — the book never reads it. */
      readonly at: string;
      readonly order: WireOrder;
    }
  | { readonly kind: 'cancel'; readonly marketId: MarketId; readonly at: string; readonly orderId: OrderId }
  | {
      readonly kind: 'amend';
      readonly marketId: MarketId;
      readonly at: string;
      readonly orderId: OrderId;
      readonly expectedVersion: number;
      readonly patch: WireAmendPatch;
      readonly lifecycleProof?: MarketLifecycleAdmissionProof;
    };

export type JournalRecord = JournalCommand & { readonly seq: number };

export interface EngineJournal {
  /** Append and make durable. Returns the record with its assigned position. */
  append(command: JournalCommand): JournalRecord;
  read(): readonly JournalRecord[];
  readonly length: number;
  close(): void;
}

// ── Conversions ─────────────────────────────────────────────────────────────

export function toWire(order: EngineOrder, lifecycleProof?: MarketLifecycleAdmissionProof): WireOrder {
  return {
    orderId: order.orderId,
    accountId: order.accountId,
    type: order.type,
    side: order.side,
    qty: formatAmount(order.qty),
    price: order.price === null ? null : formatAmount(order.price),
    stopPrice: order.stopPrice === null ? null : formatAmount(order.stopPrice),
    tif: order.tif,
    ...(order.ocoSiblingId ? { ocoSiblingId: order.ocoSiblingId } : {}),
    ...(order.expireAt ? { expireAt: order.expireAt } : {}),
    ...(order.reduceOnly ? { reduceOnly: true } : {}),
    lifecycleProof,
  };
}

export function fromWire(order: WireOrder): EngineOrder {
  return {
    orderId: order.orderId,
    accountId: order.accountId,
    type: order.type,
    side: order.side,
    qty: parseAmount(order.qty),
    price: order.price === null ? null : parseAmount(order.price),
    stopPrice: order.stopPrice === null ? null : parseAmount(order.stopPrice),
    tif: order.tif,
    ...(order.ocoSiblingId ? { ocoSiblingId: order.ocoSiblingId } : {}),
    ...(order.expireAt ? { expireAt: order.expireAt } : {}),
    ...(order.reduceOnly ? { reduceOnly: true } : {}),
  };
}

export function toWireAmend(cmd: EngineAmend): WireAmendPatch {
  return {
    ...(cmd.qty !== undefined ? { qty: formatAmount(cmd.qty) } : {}),
    ...(cmd.price !== undefined ? { price: formatAmount(cmd.price) } : {}),
    ...(cmd.stopPrice !== undefined ? { stopPrice: formatAmount(cmd.stopPrice) } : {}),
    ...(cmd.tif !== undefined ? { tif: cmd.tif } : {}),
  };
}

export function fromWireAmend(orderId: OrderId, expectedVersion: number, patch: WireAmendPatch): EngineAmend {
  return {
    orderId,
    expectedVersion,
    ...(patch.qty !== undefined ? { qty: parseAmount(patch.qty) } : {}),
    ...(patch.price !== undefined ? { price: parseAmount(patch.price) } : {}),
    ...(patch.stopPrice !== undefined ? { stopPrice: parseAmount(patch.stopPrice) } : {}),
    ...(patch.tif !== undefined ? { tif: patch.tif } : {}),
  };
}

/** Fixed key order — two equal records must serialise to identical bytes. */
function encode(record: JournalRecord): string {
  if (record.kind === 'submit') {
    const o = record.order;
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      order: {
        orderId: o.orderId,
        accountId: o.accountId,
        type: o.type,
        side: o.side,
        qty: o.qty,
        price: o.price,
        stopPrice: o.stopPrice,
        tif: o.tif,
        ...(o.ocoSiblingId ? { ocoSiblingId: o.ocoSiblingId } : {}),
        ...(o.expireAt ? { expireAt: o.expireAt } : {}),
        ...(o.reduceOnly ? { reduceOnly: true } : {}),
        lifecycleProof: o.lifecycleProof,
      },
    });
  }

  if (record.kind === 'amend') {
    const p = record.patch;
    const patch: WireAmendPatch = {
      ...(p.qty !== undefined ? { qty: p.qty } : {}),
      ...(p.price !== undefined ? { price: p.price } : {}),
      ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}),
      ...(p.tif !== undefined ? { tif: p.tif } : {}),
    };
    return JSON.stringify({
      seq: record.seq,
      kind: record.kind,
      marketId: record.marketId,
      at: record.at,
      orderId: record.orderId,
      expectedVersion: record.expectedVersion,
      patch,
      lifecycleProof: record.lifecycleProof,
    });
  }

  return JSON.stringify({ seq: record.seq, kind: record.kind, marketId: record.marketId, at: record.at, orderId: record.orderId });
}

// ── Implementations ─────────────────────────────────────────────────────────

/** For tests and single-process dev. Durable only for the life of the process. */
export class MemoryJournal implements EngineJournal {
  private readonly records: JournalRecord[] = [];

  append(command: JournalCommand): JournalRecord {
    const record = { ...command, seq: this.records.length + 1 } as JournalRecord;
    this.records.push(record);
    return record;
  }

  read(): readonly JournalRecord[] {
    return this.records;
  }

  get length(): number {
    return this.records.length;
  }

  close(): void {
    // Nothing to release.
  }
}

/**
 * Append-only NDJSON on disk, fsync'd per record.
 *
 * The fsync is the whole point and it is not negotiable: an input that is only
 * in the page cache is an input the recovery guarantee does not cover. This
 * costs throughput, which is why §5.1 marks the engine for a Rust port rather
 * than asking this file to be clever.
 *
 * SOCKET §13 — durable journal transport. A replicated log (Postgres
 * `matching.engine_journal`, or a JetStream work queue) replaces this class
 * without touching `EngineJournal`'s three methods when the engine goes
 * multi-replica.
 */
export class FileJournal implements EngineJournal {
  private readonly fd: number;
  private records: JournalRecord[];

  constructor(readonly path: string) {
    /**
     * Crash mid-write can leave a partial last NDJSON line. `decodeAll` skips
     * that residue so recovery can boot (#1520). But the torn bytes still sit
     * on disk — opening O_APPEND without rewriting would glue the next durable
     * append onto the tear, so a later boot either drops a real record or
     * throws mid-file corruption and refuses recovery. Rewrite the decoded
     * records as the clean durable body before any further append.
     */
    this.records = existsSync(path) ? decodeAll(readFileSync(path, 'utf8')) : [];
    rewriteClean(path, this.records);
    this.fd = openSync(path, 'a');
  }

  append(command: JournalCommand): JournalRecord {
    const record = { ...command, seq: this.records.length + 1 } as JournalRecord;
    const line = `${encode(record)}\n`;
    const expected = Buffer.byteLength(line, 'utf8');
    const written = writeSync(this.fd, line);
    if (written !== expected) {
      // Do not push to memory: a short write is not durable and must not look
      // like an admitted input. The process dies or the caller retries; either
      // way the on-disk body stays a complete prefix.
      throw new Error(`short journal write: wrote ${written} of ${expected} bytes at ${this.path}`);
    }
    fsyncSync(this.fd);
    this.records.push(record);
    return record;
  }

  read(): readonly JournalRecord[] {
    return this.records;
  }

  get length(): number {
    return this.records.length;
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Replace the file with exactly the durable records (no torn tail residue). */
function rewriteClean(path: string, records: readonly JournalRecord[]): void {
  const body = records.length === 0 ? '' : `${records.map((r) => encode(r)).join('\n')}\n`;
  writeFileSync(path, body, 'utf8');
  // writeFileSync does not fsync. Durability of the rewrite matters: if we
  // crash after truncating-away the partial line but before the clean body is
  // on stable storage, recovery still boots (empty or older complete prefix)
  // — never from glued garbage.
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Decode an NDJSON journal body.
 *
 * A crash mid-write can leave a partial last line (write started, fsync never
 * finished). That is not corruption of history — it is an input that never
 * became durable, so recovery must skip it and boot. A broken line in the
 * middle of the file is real corruption and still throws.
 */
export function decodeAll(contents: string): JournalRecord[] {
  const lines = contents.split('\n');
  const records: JournalRecord[] = [];
  // Last element of split is often '' after a trailing newline — track the
  // last non-empty line index so we know when a parse failure is terminal residue.
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) lastNonEmpty = i;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch (err) {
      if (i === lastNonEmpty) {
        // Truncated tail — durable records above stand; this input never landed.
        continue;
      }
      throw err;
    }
  }
  return records;
}

// ── Replay (§5.4) ───────────────────────────────────────────────────────────

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

export function replay(records: readonly JournalRecord[]): Map<MarketId, OrderBook> {
  const books = new Map<MarketId, OrderBook>();

  const bookFor = (marketId: MarketId): OrderBook => {
    let book = books.get(marketId);
    if (!book) {
      book = new OrderBook(marketId);
      books.set(marketId, book);
    }
    return book;
  };

  for (const record of records) {
    if (record.kind === 'submit') {
      const book = bookFor(record.marketId);
      book.submit(fromWire(record.order), journalClock(record.at));
      // Reject-only and IOC/market-remainder opens must not survive replay
      // either — same honesty as live dropIfNeverTraded (print or rest, or drop).
      if (book.isNeverPrintedEmpty) books.delete(record.marketId);
      continue;
    }
    /**
     * CANCEL/AMEND MUST NOT OPEN A MARKET ON REPLAY. Live cancel/amend no
     * longer journals unknown markets, but journals written before that fix
     * still contain cancel-only phantoms. Replaying those through bookFor
     * re-invented empty markets forever. Cancel/amend is a no-op when the
     * market never submitted.
     */
    const existing = books.get(record.marketId);
    if (!existing) continue;
    if (record.kind === 'amend') {
      existing.amend(fromWireAmend(record.orderId, record.expectedVersion, record.patch));
      if (existing.isNeverPrintedEmpty) books.delete(record.marketId);
      continue;
    }
    existing.cancel(record.orderId);
  }

  return books;
}

/**
 * Replay from a snapshot forward. §5.1 snapshots every N events so recovery
 * does not have to replay from the beginning of time.
 */
export function replayFrom(snapshot: EngineSnapshot, records: readonly JournalRecord[]): Map<MarketId, OrderBook> {
  const books = restoreAll(snapshot);
  const tail = records.filter((r) => r.seq > snapshot.journalSeq);

  for (const record of tail) {
    if (record.kind === 'submit') {
      let book = books.get(record.marketId);
      if (!book) {
        book = new OrderBook(record.marketId);
        books.set(record.marketId, book);
      }
      book.submit(fromWire(record.order), journalClock(record.at));
      if (book.isNeverPrintedEmpty) books.delete(record.marketId);
      continue;
    }
    // Same rule as full replay: cancel/amend never invents a market.
    const existing = books.get(record.marketId);
    if (!existing) continue;
    if (record.kind === 'amend') {
      existing.amend(fromWireAmend(record.orderId, record.expectedVersion, record.patch));
      if (existing.isNeverPrintedEmpty) books.delete(record.marketId);
      continue;
    }
    existing.cancel(record.orderId);
  }

  return books;
}

// ── Snapshots (§5.1) ────────────────────────────────────────────────────────

export interface EngineSnapshot {
  /** Journal position this snapshot is consistent with — replay resumes at `seq > journalSeq`. */
  readonly journalSeq: number;
  readonly books: readonly BookState[];
}

export function snapshot(book: OrderBook): BookState {
  return book.toState();
}

export function restore(state: BookState): OrderBook {
  return OrderBook.fromState(state);
}

/** Market ids are sorted so the snapshot of a given state is one string, not one per Map insertion order. */
export function snapshotAll(books: ReadonlyMap<MarketId, OrderBook>, journalSeq: number): EngineSnapshot {
  const ids = [...books.keys()].sort();
  return { journalSeq, books: ids.map((id) => (books.get(id) as OrderBook).toState()) };
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
