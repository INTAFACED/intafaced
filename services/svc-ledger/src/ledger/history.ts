import { z } from 'zod';
import { accountRefSchema, LedgerError, type Amount } from '@intafaced/ledger-client';

/**
 * ENTRY HISTORY — the read behind svc-bank's spend view (§8.1).
 *
 * A spend breakdown is a PROJECTION over movements that already exist in this
 * book. svc-bank does not keep `spent_this_month` counters (that would be a
 * second source of truth for money in everything but name), so it folds this
 * read on demand. Its adapter (`svc-bank/src/ledger-client.ts`) was written
 * against this shape before it existed here, and deliberately refuses rather
 * than falling back to an empty answer — a spend view that
 * silently reports zero is worse than one that is unavailable, because the user
 * cannot tell "you spent nothing" from "we could not ask".
 *
 * THIS IS A READ, AND ONLY A READ. It touches no balance, takes no chain-tip
 * lock, and has no path into `post()`. The one way it could become a second
 * write door is by growing a parameter that changes what is stored; it has
 * none, and must not.
 *
 *
 * THE BOUND, AND WHY IT REFUSES INSTEAD OF TRUNCATING.
 *
 * An account with a long enough history would otherwise hand the service an
 * unbounded row set to buffer and JSON-encode — one request is enough to exhaust
 * the heap of the process that owns every balance in the OS. So the read is
 * capped at `HISTORY_MAX_ENTRIES`.
 *
 * A cap has two possible behaviours and only one of them is honest. Returning
 * the first N entries produces an array indistinguishable from a complete one:
 * svc-bank would sum it, call the total "your spending this month", and be
 * wrong by however much fell off the end, with nothing anywhere saying so. That
 * is the same failure as the empty fallback its adapter already refuses, in
 * different clothing — a plausible number nobody can tell is short.
 *
 * So the cap is visible by construction: over it, this read REFUSES, naming the
 * cap and the window it was asked for. `ledger.history_range_too_large`
 * rehydrates through `rehydrateLedgerHttpError` as a typed `LedgerError` at the
 * caller, so svc-bank surfaces "unavailable, narrow the range" rather than a
 * quietly short total. The refusal is actionable: the same window in halves is
 * two requests that each answer.
 *
 * The query asks for `HISTORY_MAX_ENTRIES + 1` rows for exactly this reason —
 * one row is enough to know the answer would have been clipped, and it is the
 * cheapest possible way to know it. Memory stays bounded whether the read
 * answers or refuses.
 *
 * NOT PAGINATION, DELIBERATELY. A cursor is the right shape for a history the
 * user browses; nothing asks for one yet, and a `limit` without a cursor is just
 * silent truncation with a parameter in front of it. §13 socket: when a paged
 * history is needed, add `after: <entry id>` and page on `(posted_at, e.id)`,
 * which `ledger_entries_account_idx` already orders.
 *
 * THIS DOOR DOES NOT INVENT THAT FIELD. A caller that sends `after` or `cursor`
 * is asking for a page we do not serve. Zod's default strip would drop it and
 * answer the first window as if it were complete — the same lie as truncating
 * at the cap. `refuseHistoryCursor` names the socket instead.
 */

/**
 * Entries per (account, window) read.
 *
 * 10 000, matching `PostgresLedger.journal`'s cap — the two are the same kind
 * of bulk read over the same table, and one number for both is one number to
 * reason about. A month of movements for a busy trading account is order 10^3;
 * this refuses at the point where a caller is asking for a year of one, which is
 * a question for a paged history rather than for a single analytics fold.
 */
export const HISTORY_MAX_ENTRIES = 10_000;

/**
 * `from` inclusive, `to` EXCLUSIVE — a half-open window, so consecutive windows
 * neither overlap nor drop a movement. svc-bank's `HistoryRange` documents the
 * same boundary; a transaction posted at exactly midnight belongs to one day,
 * not to two and not to neither.
 */
export const historyInputSchema = z.object({
  account: accountRefSchema,
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

export type HistoryInput = z.infer<typeof historyInputSchema>;

export interface HistoryRange {
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
}

/**
 * One entry against one account, as this book recorded it.
 *
 * `amount` is a scaled bigint here and a decimal string on the wire — never a
 * `number`, on either side. `direction` is the book's own, unmodified: the sign
 * lives in the direction and never in the amount (§4.2,
 * `ledger_entries_positive_ck`), so a reader that flipped one to normalise the
 * other would be reporting a movement that did not happen.
 */
export interface HistoryEntry {
  readonly txId: string;
  readonly module: string;
  readonly reason: string;
  readonly direction: 'debit' | 'credit';
  readonly amount: Amount;
  readonly postedAt: Date;
}

/** `to` is before `from`. Empty is not the honest answer to a question that cannot be asked. */
export class HistoryRangeInvalidError extends LedgerError {
  constructor(
    readonly from: Date,
    readonly to: Date,
  ) {
    super(
      `History window ends before it starts: from ${from.toISOString()}, to ${to.toISOString()} — ` +
        '`to` is exclusive and must not precede `from`',
      'ledger.history_range_invalid',
    );
    this.name = 'HistoryRangeInvalidError';
  }
}

/**
 * Paged history is a §13 socket. Empty is not the honest answer to a page this
 * door does not serve; neither is the first `HISTORY_MAX_ENTRIES` rows.
 */
export class HistoryPageSocketError extends LedgerError {
  constructor(readonly field: 'after' | 'cursor') {
    super(
      `Paged history is a socket — this door refuses '${field}' rather than answering an unpaged window as if it were complete`,
      'ledger.history_page_socket',
    );
    this.name = 'HistoryPageSocketError';
  }
}

/**
 * More rows than one read may answer with. See the header.
 *
 * History names the account and the window. Journal names only the limit:
 * the replay has no account, and a short prefix is not the whole book.
 */
export class HistoryTooLargeError extends LedgerError {
  readonly accountId: string | undefined;
  readonly range: HistoryRange | undefined;
  readonly limit: number;

  constructor(accountId: string, range: HistoryRange, limit: number);
  constructor(limit: number);
  constructor(accountIdOrLimit: string | number, range?: HistoryRange, limit?: number) {
    const journal = typeof accountIdOrLimit === 'number';
    const resolvedLimit = journal ? accountIdOrLimit : limit!;
    super(
      journal
        ? `Journal exceeds ${resolvedLimit} transactions — a truncated journal would be indistinguishable from a complete replay`
        : `History for account ${accountIdOrLimit} between ${range!.from.toISOString()} and ${range!.to.toISOString()} ` +
            `exceeds ${resolvedLimit} entries — request a narrower window; a truncated history would be indistinguishable from a complete one`,
      'ledger.history_range_too_large',
    );
    this.name = 'HistoryTooLargeError';
    this.limit = resolvedLimit;
    if (journal) {
      this.accountId = undefined;
      this.range = undefined;
    } else {
      this.accountId = accountIdOrLimit;
      this.range = range;
    }
  }
}

/**
 * Wire timestamps to a window, refusing an inverted one.
 *
 * An inverted window matches no row, so returning `[]` would be a plausible,
 * checkable-looking answer to a request whose arguments are the wrong way round
 * — the caller's bug recorded as "you spent nothing". `from === to` is empty and
 * legal: a zero-width half-open window genuinely contains nothing, and callers
 * that iterate day by day over a boundary produce one.
 */
export function parseHistoryRange(from: string, to: string): HistoryRange {
  const range = { from: new Date(from), to: new Date(to) };
  if (range.to < range.from) throw new HistoryRangeInvalidError(range.from, range.to);
  return range;
}

/**
 * Refuse a paged-history field this door does not serve.
 *
 * Check the RAW body, before `historyInputSchema.parse` strips unknown keys.
 * Do not add `after` to the schema — that would invent the socket.
 */
export function refuseHistoryCursor(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const rec = body as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, 'after')) throw new HistoryPageSocketError('after');
  if (Object.prototype.hasOwnProperty.call(rec, 'cursor')) throw new HistoryPageSocketError('cursor');
}

/** Door parse: cursor socket first, then the window. */
export function parseHistoryDoorInput(body: unknown): HistoryInput {
  refuseHistoryCursor(body);
  return historyInputSchema.parse(body);
}
