import { z } from 'zod';
import { accountRefSchema, describeOwnerIdSpace, formatAmount, isValidOwnerId, LedgerError, type Amount } from '@intafaced/ledger-client';

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

/**
 * PAGED HISTORY (`historyPage`) — the §13 socket above, served as a SIBLING.
 *
 * `history` is untouched and still refuses `after`/`cursor`: its callers
 * (svc-bank analytics, svc-tax) fold a whole window and must never receive a
 * silently partial one. A page is a different question ("the next N, newest
 * first, I will come back for more"), with a different answer shape
 * (`{entries, nextCursor}`), so it gets its own procedure rather than a flag on
 * the one whose contract is "complete or refuse".
 *
 * WHICH ENTRIES. The caller names an owner and an account kind (and purpose);
 * `assetId` is optional. Omitted, the page spans every asset that owner holds in
 * that kind — what a user's activity feed needs; given, it is that one account.
 * The scope comes ONLY from this input, which only a service can send. The
 * cursor carries a position, never an account.
 *
 * ORDER. Newest first by posting sequence (entry id; posts are serialised under
 * the global chain_tip lock). Ids are unique, so a page boundary can fall between
 * two entries with the same timestamp without skipping or repeating either, and
 * the read walks `ledger_entries_account_idx (account_id, id)` instead of
 * sorting. There is no time filter: the cursor does the paging, and a far-past
 * time bound would have to walk every newer entry. The schema is strict, so a
 * stray `before` (or any unknown key) is refused, not silently ignored.
 */
export const HISTORY_PAGE_DEFAULT_LIMIT = 50;
export const HISTORY_PAGE_MAX_LIMIT = 200;

export const historyPageInputSchema = z
  .object({
    ...accountRefSchema.shape,
    /** Optional here (required on a plain AccountRef): omitted = all of the owner's assets. */
    assetId: z.string().min(1).max(16).optional(),
    limit: z.number().int().min(1).max(HISTORY_PAGE_MAX_LIMIT).default(HISTORY_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((ref, ctx) => {
    if (isValidOwnerId(ref.ownerType, ref.ownerId)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ownerId'],
      message: `owner_type "${ref.ownerType}" requires ${describeOwnerIdSpace(ref.ownerType)} — got "${ref.ownerId}"`,
    });
  });

export type HistoryPageInput = z.infer<typeof historyPageInputSchema>;

/**
 * Rails `historyPage` may echo back from `ledger_tx.meta.rail`. Anything else is
 * returned as `null` — meta is free-form and never leaves this door as-is.
 *
 * Built from the rails that actually reach `recipes.deposit` (meta `{ rail, railRef }`):
 *  - `crypto-native`      svc-pay/src/rails/crypto-native.ts:67 (id); operator credit svc-pay/src/user-money-service.ts:219
 *  - `card-sandbox`       svc-pay/src/rails/card-sandbox.ts:55 (id); svc-pay/src/index.ts:284 (operator-credit rail)
 *  - `bank-crypto-ledger` svc-bank/src/ramps/rails.ts:64 (BANK_CRYPTO_LEDGER_RAIL); on-ramp svc-bank/src/ramps/ramp-service.ts:285
 * Operator ("admin") credits post the rail named in PAY_OPERATOR_CREDIT_RAILS
 * (svc-pay/src/router.ts:1467), so they carry one of the above and stay ordinary deposits.
 *  - `local-test`         the local test stack's labelled welcome credit
 *    (tooling/scripts/local-test-world.mjs:10, stack worktree). A display label only;
 *    production has no welcome rail.
 */
export const HISTORY_RAILS = ['crypto-native', 'card-sandbox', 'bank-crypto-ledger', 'local-test'] as const;
export type HistoryRail = (typeof HISTORY_RAILS)[number];

const HISTORY_RAIL_SET: ReadonlySet<string> = new Set(HISTORY_RAILS);

/** `meta.rail` if it is an allow-listed rail, else `null`. */
export function allowedHistoryRail(raw: unknown): HistoryRail | null {
  return typeof raw === 'string' && HISTORY_RAIL_SET.has(raw) ? (raw as HistoryRail) : null;
}

/**
 * Trade postings whose customer line belongs to one order, and which of them name the order by the
 * owner's own order-hold account (`purpose` = `order:<id>`) that the SAME transaction moves.
 *
 * WHY THE HOLD ACCOUNT AND NOT `meta`. A fill's meta names both orders (`takerOrderId`, `makerOrderId`)
 * but neither user, so a reader of the meta alone cannot tell which order is the page owner's. The
 * transaction's own entries can: `tradeFill` and `marketMakerMakerFill` credit each party's order hold
 * and debit that party's `available`, so the hold account owned by the page owner IS the owner's order,
 * and the counterparty's order id is never read. For a hold, an amend and a release the owner has exactly
 * one order hold in the transaction, and its purpose is the same id as `meta.orderId`.
 *
 * ON A FILL, WHICH HOLD. The owner's `available` line receives the asset the COUNTERPARTY paid; the owner's
 * own order was held in the asset the owner paid. So on a fill the order is the owner's hold whose asset is
 * NOT the line's asset. That also keeps a self-trade (one user on both sides, two holds in one transaction)
 * exact. Every other reason has one hold, no asset test.
 */
/** `order:<id>` hold purpose to `<id>`. Anything that is not a plain id (or not an order hold) is `null`. */
const ORDER_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export function orderIdFromHoldPurpose(purpose: unknown): string | null {
  if (typeof purpose !== 'string' || !purpose.startsWith('order:')) return null;
  const id = purpose.slice('order:'.length);
  return ORDER_ID_PATTERN.test(id) ? id : null;
}

/**
 * ON A FILL, THE FEE. `tradeFill` and `marketMakerMakerFill` take each side's fee out of what that side receives and book
 * it to `houseFees('trade', <that asset>)` in the same transaction, leaving the fee leg out when it is zero. The page
 * owner's `available` line that receives a fill is that side's net amount, so its fee is the trade-fee leg of the SAME
 * transaction in the SAME asset: the other side's fee is always in the other asset, and a self-trade receives each asset
 * once. `fee` is that leg's amount, `0` when the transaction booked none, and `null` on every other line (a hold, a paying
 * leg, any other reason), where the ledger has no fee to name.
 */
export const FILL_FEE_REASONS = ['trade.fill', 'trade.fill.mm_maker'] as const;

/**
 * One entry on a page: the history shape plus the asset, which a multi-asset page needs to mean anything,
 * the `entryId` (bigserial `ledger_entries.id`, decimal string) a caller resumes from, the allow-listed `rail`,
 * the `orderId` of the page owner's own trade order when this line belongs to one (else `null`), and the `fee` taken
 * from this line when it is the owner's receiving side of a fill (else `null`).
 */
export interface HistoryPageEntry extends HistoryEntry {
  readonly assetId: string;
  readonly entryId: string;
  readonly rail: HistoryRail | null;
  readonly orderId: string | null;
  readonly fee: Amount | null;
}

export interface HistoryPage {
  readonly entries: HistoryPageEntry[];
  /** Pass back as `cursor` for the next (older) page; `null` when this was the last. */
  readonly nextCursor: string | null;
}

export interface HistoryCursorPosition {
  /** `ledger_entries.id` (bigserial) as a decimal string. */
  readonly entryId: string;
}

/** A cursor that is not one this door issued. A forged or mangled cursor is a refusal, never "page one". */
export class HistoryCursorInvalidError extends LedgerError {
  constructor() {
    super('History cursor is not valid — start again without a cursor', 'ledger.history_cursor_invalid');
    this.name = 'HistoryCursorInvalidError';
  }
}

const BIGINT_MAX = 9223372036854775807n;

/** Opaque to callers: base64url of `v2.<entry id>`. */
export function encodeHistoryCursor(pos: HistoryCursorPosition): string {
  return Buffer.from(`v2.${pos.entryId}`, 'utf8').toString('base64url');
}

export function decodeHistoryCursor(cursor: string): HistoryCursorPosition {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new HistoryCursorInvalidError();
  const m = /^v2\.(\d{1,19})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!m) throw new HistoryCursorInvalidError();
  const id = BigInt(m[1]!);
  if (id < 1n || id > BIGINT_MAX) throw new HistoryCursorInvalidError();
  return { entryId: id.toString() };
}

/** Door parse. Does NOT call `refuseHistoryCursor`: here `cursor` is the field. */
export function parseHistoryPageInput(body: unknown): HistoryPageInput {
  return historyPageInputSchema.parse(body);
}

/** Wire form of a page: decimal-string amounts, ISO timestamps. `formatAmount` is the only encoder. */
export function serializeHistoryPage(page: HistoryPage) {
  return {
    entries: page.entries.map((e) => ({
      txId: e.txId,
      module: e.module,
      reason: e.reason,
      direction: e.direction,
      amount: formatAmount(e.amount),
      postedAt: e.postedAt.toISOString(),
      assetId: e.assetId,
      entryId: e.entryId,
      rail: e.rail,
      orderId: e.orderId,
      fee: e.fee === null ? null : formatAmount(e.fee),
    })),
    nextCursor: page.nextCursor,
  };
}
