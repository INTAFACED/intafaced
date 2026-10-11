import type { Amount } from '@intafaced/ledger-client/money';
import {
  VenueUnavailableError,
  midFromSnapshot,
  type MarketDataAdapter,
  type VenueBookSnapshot,
  type VenueUnavailableReason,
} from '@intafaced/venue-contracts';

/**
 * CAPTURE LAKE HONESTY — §27:762 / D-S-18 (connect.data-lake residual).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS DECIDED HERE, AND WHAT IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Decided (D-S-18 + tracker `connect.data-lake`): capture only, and a venue that
 * is not connected is ABSENT in the record — never an empty book. A hole in
 * capture must be readable as a hole, not as a quiet market.
 *
 * Not decided: the time-series store, retention, compose provisioning, or
 * whether §29 Quant ships to users. This module is an in-memory append log of
 * normalised capture facts. It is the honesty boundary a future store must
 * preserve — not the store itself.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAILURE THIS SHAPE EXISTS TO MAKE IMPOSSIBLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The tempting substitute for "we did not capture" is an empty book. An empty
 * book is a market condition (quiet). A missing adapter, a transport failure,
 * or a refused dust book is a capture hole. Collapsing the second into the
 * first makes a backtest read silence as "no liquidity that day", which is
 * exactly how §29 would invent a past. So:
 *
 *   · Connected adapter returns a snapshot of the requested instrument (including empty) → `book`.
 *   · Snapshot names a different venue or symbol → `hole` (`not_connected`), not stored.
 *   · No adapter / unavailable / unknown failure → `hole` with a typed reason.
 *   · Readers that want a book get `null` for a hole — never a synthetic empty.
 */

/** Why a capture slot holds no book. Distinct from "bids and asks were empty". */
export type CaptureHoleReason = 'not_connected' | VenueUnavailableReason | 'capture_failed';

export interface CaptureBookRecord {
  readonly kind: 'book';
  readonly venueId: string;
  readonly symbol: string;
  /** When THIS PROCESS finished the capture write. Our clock. */
  readonly capturedAt: Date;
  readonly snapshot: VenueBookSnapshot;
}

export interface CaptureHoleRecord {
  readonly kind: 'hole';
  readonly venueId: string;
  readonly symbol: string;
  readonly capturedAt: Date;
  readonly reason: CaptureHoleReason;
  readonly detail: string;
}

export type CaptureRecord = CaptureBookRecord | CaptureHoleRecord;

export function isCaptureHole(record: CaptureRecord): record is CaptureHoleRecord {
  return record.kind === 'hole';
}

export function isCaptureBook(record: CaptureRecord): record is CaptureBookRecord {
  return record.kind === 'book';
}

/**
 * True only when a real adapter returned a two-sided-empty snapshot.
 * A hole is never a quiet market — that is the whole point of this module.
 */
export function isQuietMarketBook(record: CaptureRecord): boolean {
  return record.kind === 'book' && record.snapshot.bids.length === 0 && record.snapshot.asks.length === 0;
}

/**
 * Book view for consumers. Holes return `null` so a missing capture cannot be
 * misread as empty depth. Never invents levels or a mid.
 */
export function bookFromCapture(record: CaptureRecord): VenueBookSnapshot | null {
  return record.kind === 'book' ? record.snapshot : null;
}

/**
 * Mid from a capture record. Holes, empty books, and one-sided books are
 * `null` — never a last-trade and never zero-as-price.
 */
export function midFromCapture(record: CaptureRecord): Amount | null {
  return midFromSnapshot(bookFromCapture(record));
}

function holeReasonFromUnavailable(reason: VenueUnavailableReason): CaptureHoleReason {
  return reason;
}

export interface CaptureLakeClock {
  now(): Date;
}

const SYSTEM_CLOCK: CaptureLakeClock = {
  now: () => new Date(),
};

/**
 * Append-only capture log. No persistence — store choice is owner/D-S-18 open.
 * Every write is a fact: either a normalised book or a named hole.
 */
export class CaptureLake {
  private readonly log: CaptureRecord[] = [];

  constructor(private readonly clock: CaptureLakeClock = SYSTEM_CLOCK) {}

  /** All records in append order. Holes are first-class, not omitted. */
  records(): readonly CaptureRecord[] {
    return this.log;
  }

  holes(): readonly CaptureHoleRecord[] {
    return this.log.filter(isCaptureHole);
  }

  /**
   * Record a successful book observation. Empty bids/asks are allowed — that
   * is a quiet market fact from a connected venue, not an invented substitute
   * for absence.
   */
  recordBook(snapshot: VenueBookSnapshot): CaptureBookRecord {
    const record: CaptureBookRecord = {
      kind: 'book',
      venueId: snapshot.venueId,
      symbol: snapshot.symbol,
      capturedAt: this.clock.now(),
      snapshot,
    };
    this.log.push(record);
    return record;
  }

  /** Explicit hole. Callers must not follow this with a synthetic empty book. */
  recordHole(venueId: string, symbol: string, reason: CaptureHoleReason, detail: string): CaptureHoleRecord {
    const record: CaptureHoleRecord = {
      kind: 'hole',
      venueId,
      symbol,
      capturedAt: this.clock.now(),
      reason,
      detail,
    };
    this.log.push(record);
    return record;
  }

  /**
   * Capture one book from an adapter.
   *
   * `adapter === null` → hole `not_connected` (venue absent, never empty book).
   * Snapshot venue id or symbol ≠ the trimmed request → hole `not_connected`.
   * That foreign snapshot is not stored as a book.
   * `VenueUnavailableError` → hole with the venue reason (incl. `no_depth`).
   * Other throw → hole `capture_failed`.
   * Matching snapshot → book record, empty or not.
   */
  async captureBook(
    adapter: Pick<MarketDataAdapter, 'venue' | 'snapshotBook'> | null,
    venueId: string,
    symbol: string,
    limit?: number,
  ): Promise<CaptureRecord> {
    const id = venueId.trim();
    const sym = symbol.trim();
    if (!adapter) {
      return this.recordHole(id, sym, 'not_connected', `${id}: no MarketDataAdapter — absent in capture, not an empty book`);
    }
    if (adapter.venue.id !== id) {
      return this.recordHole(
        id,
        sym,
        'not_connected',
        `${id}: adapter venue is ${adapter.venue.id} — refusing to stamp the wrong id onto a book`,
      );
    }
    try {
      const snapshot = await adapter.snapshotBook(sym, limit);
      if (snapshot.venueId !== id || snapshot.symbol !== sym) {
        return this.recordHole(
          id,
          sym,
          'not_connected',
          `${id} ${sym}: snapshot is ${snapshot.venueId} ${snapshot.symbol} — requested instrument was not stored as a book`,
        );
      }
      return this.recordBook(snapshot);
    } catch (error) {
      if (error instanceof VenueUnavailableError) {
        return this.recordHole(id, sym, holeReasonFromUnavailable(error.reason), error.message);
      }
      const detail = error instanceof Error ? error.message : 'unknown capture failure';
      return this.recordHole(id, sym, 'capture_failed', detail);
    }
  }
}
