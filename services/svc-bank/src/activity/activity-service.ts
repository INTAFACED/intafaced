import { parseAmount } from '@intafaced/ledger-client';
import { PAR_ASSETS } from '../portfolio/valuation.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import { classify, directionOf, type ActivityKind, type EntryDirection } from './activity-kind.js';
import { ActivityCursorInvalidError, decodeCursor, encodeCursor, type OwnerPosition } from './activity-cursor.js';
import type { ActivityAnnotation, ActivityRecordService } from './activity-records.js';

/**
 * ACTIVITY — the signed-in user's merged money history, newest first (U5b).
 *
 * A READ, AND ONLY A READ, over svc-ledger's `historyPage`. Nothing is stored
 * here and nothing is written: the ledger is the record, this is a typed view.
 *
 * WHOSE MONEY. `userId` is the verified principal. The owners read are that
 * user's own account plus every named Space they own, taken from svc-bank's own
 * Space table filtered by `user_id` (the rule `portfolio-service.ts` uses). No
 * input names an owner, and a cursor only ever supplies positions for owners the
 * session already has (activity-cursor.ts).
 *
 * WHAT IS IN IT. Posted ledger entries on the owners' `available` accounts, so
 * every row is `completed`. Pending items (a withdrawal request that has not
 * posted, an on-ramp awaiting its rail) are NOT here; they live in the ramp and
 * withdrawal records and are a separate, later read. An `order.hold` or
 * `withdraw.held` shows as the posted movement it is.
 *
 * MERGE-PAGING. Each owner is read `limit` newest-first, the heads are merged by
 * `postedAt` (then tx id) descending, and the first `limit` are the page. For
 * each owner the cursor then records where it stopped: the ledger's own cursor
 * when the whole fetched page was used, or a re-read of exactly the consumed
 * count when it was not (or, when the ledger returns each entry's `entryId`,
 * resume exactly below the last entry shown, with no re-read). Owners merge by
 * `postedAt`, then `entryId` (then tx id on a ledger that does not send it);
 * within one owner the ledger's own order is never disturbed. A transaction is never split across a page boundary where
 * its other half is visible.
 */

export type ActivityStatus = 'completed';

export interface ActivityItem {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly direction: 'in' | 'out';
  readonly asset: string;
  /** Unsigned decimal string. The direction carries the sign. */
  readonly amount: string;
  readonly postedAt: string;
  readonly txId: string;
  readonly counterparty: { readonly handle: string } | null;
  readonly spaceName: string | null;
  /**
   * The user's own trade order this line belongs to, only when the ledger links the posting to one:
   * a fill leg, an order hold, a hold amend or a release. Omitted for every other line. A fill carries
   * the order of the user whose line it is (never the counterparty's), so a screen can group one
   * order's lines exactly instead of guessing by time.
   */
  readonly orderId?: string;
  /** Set on the line that brought in the asset the customer bought. Absent on a sale, a refund and every other line. */
  readonly purchase?: true;
  /**
   * Transfer note, visible to both parties. A personal send takes it from that
   * send's record. A space-to-space transfer takes it from the transfer message.
   * Absent when that transfer had none.
   */
  readonly note?: string;
  /** Payment reference, visible to both parties. Same single source as the note. */
  readonly reference?: string;
  /** The caller's own note. Not shown to the other party. */
  readonly privateNote?: string;
  /** The caller's own second note, used in reports and exports. Not shown to the other party. */
  readonly reportDescription?: string;
  /** An open dispute this caller filed. Status stays open; nothing here is a refund. */
  readonly dispute?: { readonly id: string; readonly status: 'open'; readonly reason: string };
  /**
   * The crypto address a withdrawal went to, when this service recorded one. Absent on every other line: a line with
   * no address says so by having none, and the address filter never matches it.
   */
  readonly address?: string;
}

export interface ActivityPage {
  readonly items: ActivityItem[];
  readonly nextCursor: string | null;
}

/** One row of svc-ledger `/trpc/historyPage`, amounts as the decimal strings the wire carries. */
export interface LedgerPageEntry {
  readonly txId: string;
  readonly module: string;
  readonly reason: string;
  readonly direction: EntryDirection;
  readonly amount: string;
  readonly postedAt: Date;
  readonly assetId: string;
  /** Position in the book, a decimal string (newer = larger). Absent until svc-ledger sends it; then used for exact resume. */
  readonly entryId?: string;
  /** Allow-listed rail of a deposit posting, else null. Absent until svc-ledger sends it. */
  readonly rail?: string | null;
  /** The page owner's own trade order this posting belongs to, else null. Absent until svc-ledger sends it. */
  readonly orderId?: string | null;
}

export interface LedgerPageRequest {
  readonly ownerType: 'user' | 'subaccount';
  readonly ownerId: string;
  readonly kind: 'available';
  readonly assetId?: string;
  readonly limit: number;
  readonly cursor?: string;
}

/** The port over svc-ledger `historyPage`. Throws on any failure. */
export interface LedgerHistoryPages {
  page(request: LedgerPageRequest): Promise<{ entries: LedgerPageEntry[]; nextCursor: string | null }>;
}

/**
 * Optional: the other side's public handle for a transfer, by tx id. svc-bank
 * stores no counterparty and the ledger page names none, so nothing is wired
 * today and every counterparty is null. A resolver returns a HANDLE only, never
 * a user id.
 */
export interface ActivityCounterparties {
  handlesFor(userId: string, txIds: readonly string[]): Promise<ReadonlyMap<string, { handle: string }>>;
}

export interface SpaceLister {
  /** Every named Space the user owns, archived and empty ones included: history outlives a closed Space. */
  allNamedSpaces(userId: string, assetId?: string): Promise<SpaceRecord[]>;
}

export interface TransferFact {
  readonly note: string | null;
  /** Payment reference on a personal send. Absent when that send had none. */
  readonly reference?: string | null;
  readonly counterpartyHandle: string | null;
}

/** Note and the other party's handle for personal sends this service recorded, keyed by ledger tx id. */
export interface ActivityTransferFacts {
  forTransfers(userId: string, txIds: readonly string[]): Promise<ReadonlyMap<string, TransferFact>>;
}

export interface ActivityServiceOptions {
  /** Unset = every call refuses `ActivityUnavailableError`. Never an empty list. */
  pages?: LedgerHistoryPages;
  /** Signs page cursors. Required with `pages`. */
  cursorSecret?: string;
  counterparties?: ActivityCounterparties;
  /** Note, reference and the other party's handle for personal sends. */
  transferFacts?: ActivityTransferFacts;
  /** Space-transfer words, private notes and disputes. Unset = those fields stay absent. A failure never hides a line. */
  records?: Pick<ActivityRecordService, 'forItems'> & Partial<Pick<ActivityRecordService, 'addressesFor'>>;
}

/** The date range is backwards. */
export class ActivityRangeError extends Error {
  readonly code = 'bank.activity_range' as const;
  constructor() {
    super('The end of the range is before the start');
    this.name = 'ActivityRangeError';
  }
}

/** The id is not in this customer's activity. */
export class ActivityNotFoundError extends Error {
  readonly code = 'bank.activity_not_found' as const;
  constructor() {
    super('That transaction is not in your activity');
    this.name = 'ActivityNotFoundError';
  }
}

/** The scan stopped before the history ended, so "not found" would be a guess. */
export class ActivityLookupBoundedError extends Error {
  readonly code = 'bank.activity_lookup_bounded' as const;
  constructor() {
    super('Activity lookup stopped before the end of your history. Try again.');
    this.name = 'ActivityLookupBoundedError';
  }
}

/** The tax year starts on a date only the owner and counsel can set, and none is set. */
export class ActivityTaxYearUnsetError extends Error {
  readonly code = 'portfolio.tax_year_start_unset' as const;
  constructor() {
    super('The tax year start is not set. Filter by calendar year instead');
    this.name = 'ActivityTaxYearUnsetError';
  }
}

/**
 * How each kind of line is taxed. The mapping is a tax call only the owner and counsel can make, so it is empty and
 * no line is ever given an effect.
 */
export const TAX_EFFECT_BY_KIND: Readonly<Partial<Record<ActivityKind, string>>> = {};

export class ActivityTaxEffectMapUnsetError extends Error {
  readonly code = 'portfolio.tax_effect_map_unset' as const;
  constructor() {
    super('The tax effect of each kind of line is not set');
    this.name = 'ActivityTaxEffectMapUnsetError';
  }
}

/** Oldest-first needs the whole range in hand; this history is too long to hold. */
export class ActivitySortBoundedError extends Error {
  readonly code = 'bank.activity_sort_bounded' as const;
  constructor() {
    super('Oldest first is limited to 2,000 matching lines. Narrow the dates, the account or the filters');
    this.name = 'ActivitySortBoundedError';
  }
}

/** The account is not one of this customer's. */
export class ActivityAccountUnknownError extends Error {
  readonly code = 'bank.activity_account_unknown' as const;
  constructor() {
    super('That account is not yours');
    this.name = 'ActivityAccountUnknownError';
  }
}

export interface ActivityFilter {
  readonly kind?: readonly ActivityKind[];
  readonly direction?: 'in' | 'out';
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly minAmount?: string;
  readonly maxAmount?: string;
  /** `main` or one named Space id. */
  readonly accountId?: string;
  readonly address?: string;
  /** Only lines the caller has written a private note on. */
  readonly hasNote?: boolean;
}

export interface ActivityQuery {
  limit?: number;
  cursor?: string;
  assetId?: string;
  kind?: ActivityKind[];
  direction?: 'in' | 'out';
  from?: string;
  to?: string;
  q?: string;
  minAmount?: string;
  maxAmount?: string;
  /** `main` (the account itself) or the id of one named Space. */
  accountId?: string;
  /** Newest first unless `asc`. */
  sort?: 'asc' | 'desc';
  /** A UTC calendar year. Narrows `from` and `to`. */
  year?: number;
  /** A tax year. Its start is an owner value that is not set, so this always refuses. */
  taxYear?: number;
  /** Part of a withdrawal address, matched without regard to case. Lines with no recorded address never match. */
  address?: string;
  /** True keeps only lines with a private note of the caller's own. */
  hasNote?: boolean;
}

/** Oldest-first holds the matching lines in memory: at most this many, then it refuses and asks for a narrower range. */
const ASC_MAX_ITEMS = 2_000;
const ASC_MAX_CALLS = 25;
const FILTER_WINDOW = 100;
const FILTER_SCAN_MAX = 2_000;
const GET_PAGE = 100;
const GET_MAX_PAGES = 100;

export function activityFilterKey(filter: ActivityFilter, order: 'asc' | 'desc' = 'desc'): string {
  return JSON.stringify({
    k: filter.kind ? [...filter.kind].sort() : null,
    d: filter.direction ?? null,
    f: filter.from ?? null,
    t: filter.to ?? null,
    q: filter.q ?? null,
    n: filter.minAmount ?? null,
    x: filter.maxAmount ?? null,
    ...(filter.accountId ? { a: filter.accountId } : {}),
    ...(filter.address ? { r: filter.address } : {}),
    ...(filter.hasNote ? { h: 1 } : {}),
    ...(order === 'asc' ? { o: 'asc' } : {}),
  });
}

function hasFilter(input: ActivityQuery): boolean {
  return (
    input.kind !== undefined ||
    input.direction !== undefined ||
    input.from !== undefined ||
    input.to !== undefined ||
    input.q !== undefined ||
    input.minAmount !== undefined ||
    input.maxAmount !== undefined ||
    input.accountId !== undefined ||
    input.year !== undefined ||
    input.taxYear !== undefined ||
    input.address !== undefined ||
    input.hasNote !== undefined
  );
}

function readFilter(input: ActivityQuery): ActivityFilter {
  if (input.taxYear !== undefined) throw new ActivityTaxYearUnsetError();
  // A calendar year is the UTC year, first millisecond to last, narrowed by any range the caller also gave.
  let from = input.from;
  let to = input.to;
  if (input.year !== undefined) {
    const yearFrom = Date.UTC(input.year, 0, 1);
    const yearTo = Date.UTC(input.year + 1, 0, 1) - 1;
    if (from === undefined || Date.parse(from) < yearFrom) from = new Date(yearFrom).toISOString();
    if (to === undefined || Date.parse(to) > yearTo) to = new Date(yearTo).toISOString();
  }
  const filter: ActivityFilter = {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.direction ? { direction: input.direction } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.address ? { address: input.address.trim().toLowerCase() } : {}),
    ...(input.hasNote ? { hasNote: true } : {}),
    ...(input.q ? { q: input.q.trim().toLowerCase() } : {}),
    ...(input.minAmount ? { minAmount: input.minAmount } : {}),
    ...(input.maxAmount ? { maxAmount: input.maxAmount } : {}),
  };
  if (filter.from && filter.to && Date.parse(filter.from) > Date.parse(filter.to)) throw new ActivityRangeError();
  if (filter.minAmount && filter.maxAmount && parseAmount(filter.minAmount) > parseAmount(filter.maxAmount)) {
    throw new ActivityRangeError();
  }
  return filter;
}

/** The account an activity id was read from: `main` or a Space id. Ids are `<txId>:<owner key>:<asset>:<direction>`. */
function accountOf(item: Pick<ActivityItem, 'id' | 'txId'>): string | null {
  if (!item.id.startsWith(`${item.txId}:`)) return null;
  const rest = item.id.slice(item.txId.length + 1);
  if (rest.startsWith('u:')) return 'main';
  const m = /^s:([^:]+):/.exec(rest);
  return m ? m[1]! : null;
}

/**
 * True for the line that brought in the asset the customer bought. The feed shows only the asset a fill paid out, so a
 * sale looks like "USDT in" as a purchase would: a spot fill counts only when the asset received is not a quote
 * asset (USDT, USDC, USD), the markets this platform prices against. An escrow release is always a buy of what it
 * released. Futures margin and profit, and an escrow refund (the seller's own coin coming back), are never purchases.
 */
function isPurchase(entry: { module: string; reason: string; assetId: string }, direction: 'in' | 'out'): boolean {
  if (direction !== 'in') return false;
  const key = `${entry.module}/${entry.reason}`;
  if (key === 'p2p/p2p.escrow.release') return true;
  return (key === 'trade/trade.fill' || key === 'trade/trade.fill.mm_maker') && !PAR_ASSETS.has(entry.assetId.toUpperCase());
}

function itemMatches(item: ActivityItem, filter: ActivityFilter): boolean {
  if (filter.accountId && accountOf(item) !== filter.accountId) return false;
  if (filter.kind && !filter.kind.includes(item.kind)) return false;
  if (filter.direction && item.direction !== filter.direction) return false;
  const amount = parseAmount(item.amount);
  if (filter.minAmount && amount < parseAmount(filter.minAmount)) return false;
  if (filter.maxAmount && amount > parseAmount(filter.maxAmount)) return false;
  if (filter.hasNote && item.privateNote === undefined && item.reportDescription === undefined) return false;
  if (filter.address && !(item.address ?? '').toLowerCase().includes(filter.address)) return false;
  if (!filter.q) return true;
  const haystack = [
    item.kind,
    item.direction,
    item.asset,
    item.amount,
    item.txId,
    item.id,
    item.spaceName ?? '',
    item.counterparty?.handle ?? '',
    item.note ?? '',
    item.reference ?? '',
    item.privateNote ?? '',
    item.orderId ?? '',
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(filter.q);
}

/** The feed cannot be served right now. A retry may work; the caller sent nothing wrong. */
export class ActivityUnavailableError extends Error {
  constructor(message = 'Activity is not available right now') {
    super(message);
    this.name = 'ActivityUnavailableError';
  }
}

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;
/** One ledger read per owner per page. Past this the feed refuses rather than silently omit a Space. */
export const ACTIVITY_MAX_OWNERS = 100;
const FETCH_CONCURRENCY = 8;

interface Owner {
  readonly key: string;
  readonly ownerType: 'user' | 'subaccount';
  readonly ownerId: string;
  readonly spaceName: string | null;
}

interface Queue {
  readonly owner: Owner;
  readonly start: string | null;
  readonly entries: LedgerPageEntry[];
  readonly next: string | null;
  taken: number;
}

interface Taken {
  readonly entry: LedgerPageEntry;
  readonly queue: Queue;
}

/**
 * svc-ledger's opaque cursor for "entries older than this entry id": base64url of
 * `v2.<entryId>` (services/svc-ledger/src/ledger/history.ts). Built here only from
 * an `entryId` the ledger itself returned; the ledger validates it on use, so a
 * wrong one is refused there, never trusted here.
 */
function ledgerCursorBelow(entryId: string): string {
  return Buffer.from(`v2.${entryId}`, 'utf8').toString('base64url');
}

const TRANSFER_REASONS = new Set(['bank/bank.transfer.manual', 'bank/bank.transfer.scheduled']);

/** Positive when `a` belongs AFTER `b` in a newest-first list. */
function after(a: LedgerPageEntry, b: LedgerPageEntry): number {
  const t = b.postedAt.getTime() - a.postedAt.getTime();
  if (t !== 0) return t;
  if (a.entryId !== undefined && b.entryId !== undefined && a.entryId !== b.entryId) {
    return BigInt(b.entryId) > BigInt(a.entryId) ? 1 : -1;
  }
  return a.txId < b.txId ? 1 : a.txId > b.txId ? -1 : 0;
}

export class ActivityService {
  constructor(
    private readonly spaces: SpaceLister,
    private readonly options: ActivityServiceOptions = {},
  ) {}

  /** `userId` is the verified principal, never input. */
  async list(userId: string, input: ActivityQuery = {}): Promise<ActivityPage> {
    if (input.sort === 'asc') return this.listOldestFirst(userId, input);
    if (!hasFilter(input)) return this.listPage(userId, input);
    return this.listFiltered(userId, input);
  }

  /**
   * One activity line, plus the other lines of the same ledger transaction.
   * `order:<orderId>` returns every line the ledger links to that order.
   * An activity id is a ledger transaction id (a uuid) plus its owner, so it
   * does not start with `order:`.
   */
  async get(userId: string, id: string): Promise<{ item: ActivityItem; lines: ActivityItem[]; complete: boolean }> {
    if (id.startsWith('order:')) {
      const orderId = id.slice('order:'.length);
      if (orderId.length < 1 || orderId.length > 128) throw new ActivityNotFoundError();
      return this.findOrder(userId, orderId);
    }
    return this.findItem(userId, id);
  }

  /**
   * Every matching line in the range, newest first, for a statement.
   * Stops after `limit` matches and leaves the caller to notice a short page
   * only when history ended. The caller passes limit+1 to detect overflow.
   */
  async collect(
    userId: string,
    input: { from: string; to: string; assetId?: string; accountId?: string; kind?: ActivityKind[]; limit: number },
  ): Promise<ActivityItem[]> {
    const items: ActivityItem[] = [];
    let cursor: string | undefined;
    while (items.length < input.limit) {
      const page = await this.list(userId, {
        limit: Math.min(200, input.limit - items.length),
        cursor,
        assetId: input.assetId,
        from: input.from,
        to: input.to,
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
      });
      items.push(...page.items);
      if (!page.nextCursor) break;
      if (page.items.length === 0 && cursor === page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return items;
  }

  private async listFiltered(userId: string, input: ActivityQuery): Promise<ActivityPage> {
    const { cursorSecret } = this.options;
    if (!this.options.pages || !cursorSecret) throw new ActivityUnavailableError();
    const filter = readFilter(input);
    if (filter.accountId !== undefined) await this.assertAccount(userId, input.assetId ?? null, filter.accountId);
    const filterKey = activityFilterKey(filter);
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? ACTIVITY_DEFAULT_LIMIT), 1), ACTIVITY_MAX_LIMIT);
    const assetId = input.assetId ?? null;
    const start = input.cursor === undefined ? null : decodeCursor(cursorSecret, input.cursor, { userId, assetId, filterKey });
    let positionCursor = start === null ? undefined : encodeCursor(cursorSecret, { userId, assetId, owners: start.owners });
    let skip = start?.skip ?? 0;
    const matches: ActivityItem[] = [];
    let scanned = 0;
    while (matches.length < limit && scanned < FILTER_SCAN_MAX) {
      const window = await this.listPage(userId, {
        limit: FILTER_WINDOW,
        cursor: positionCursor,
        ...(assetId === null ? {} : { assetId }),
        ...(filter.address === undefined ? {} : { needAddress: true }),
        ...(filter.hasNote ? { needNotes: true } : {}),
      });
      scanned += window.items.length;
      const kept: ActivityItem[] = [];
      let older = false;
      const fromMs = filter.from ? Date.parse(filter.from) : null;
      const toMs = filter.to ? Date.parse(filter.to) : null;
      for (const item of window.items) {
        const at = Date.parse(item.postedAt);
        if (toMs !== null && at > toMs) continue;
        if (fromMs !== null && at < fromMs) {
          older = true;
          break;
        }
        if (itemMatches(item, filter)) kept.push(item);
      }
      const rest = kept.slice(skip);
      const take = rest.slice(0, limit - matches.length);
      matches.push(...take);
      const windowStart = await this.positionBody(userId, assetId, positionCursor);
      if (take.length < rest.length) {
        return {
          items: matches,
          nextCursor: encodeCursor(cursorSecret, { ...windowStart, filterKey, skip: skip + take.length }),
        };
      }
      if (older || window.nextCursor === null) return { items: matches, nextCursor: null };
      if (window.items.length === 0) return { items: matches, nextCursor: null };
      positionCursor = window.nextCursor;
      skip = 0;
      if (scanned >= FILTER_SCAN_MAX && matches.length < limit) {
        const end = decodeCursor(cursorSecret, window.nextCursor, { userId, assetId });
        return { items: matches, nextCursor: encodeCursor(cursorSecret, { ...end, filterKey, skip: 0 }) };
      }
    }
    if (positionCursor === undefined) return { items: matches, nextCursor: null };
    const end = decodeCursor(cursorSecret, positionCursor, { userId, assetId });
    const more = matches.length >= limit;
    return { items: matches, nextCursor: more ? encodeCursor(cursorSecret, { ...end, filterKey, skip: 0 }) : null };
  }

  private async positionBody(
    userId: string,
    assetId: string | null,
    cursor: string | undefined,
  ): Promise<{ userId: string; assetId: string | null; owners: Record<string, OwnerPosition> }> {
    if (cursor !== undefined) {
      const body = decodeCursor(this.options.cursorSecret ?? '', cursor, { userId, assetId });
      return { userId, assetId, owners: { ...body.owners } };
    }
    const owners = await this.ownersOf(userId, assetId);
    const map: Record<string, OwnerPosition> = {};
    for (const owner of owners) map[owner.key] = null;
    return { userId, assetId, owners: map };
  }

  private async findItem(userId: string, id: string): Promise<{ item: ActivityItem; lines: ActivityItem[]; complete: boolean }> {
    let cursor: string | undefined;
    for (let page = 0; page < GET_MAX_PAGES; page += 1) {
      const got = await this.listPage(userId, { limit: GET_PAGE, cursor });
      const hit = got.items.find((item) => item.id === id);
      if (hit) {
        return { item: hit, lines: got.items.filter((item) => item.txId === hit.txId), complete: true };
      }
      if (!got.nextCursor) throw new ActivityNotFoundError();
      cursor = got.nextCursor;
    }
    throw new ActivityLookupBoundedError();
  }

  private async findOrder(userId: string, orderId: string): Promise<{ item: ActivityItem; lines: ActivityItem[]; complete: boolean }> {
    const lines: ActivityItem[] = [];
    let cursor: string | undefined;
    let complete = true;
    for (let page = 0; page < GET_MAX_PAGES; page += 1) {
      const got = await this.listPage(userId, { limit: GET_PAGE, cursor });
      for (const item of got.items) if (item.orderId === orderId) lines.push(item);
      if (!got.nextCursor) break;
      cursor = got.nextCursor;
      if (page === GET_MAX_PAGES - 1) complete = false;
    }
    const item = lines[0];
    if (!item) {
      if (!complete) throw new ActivityLookupBoundedError();
      throw new ActivityNotFoundError();
    }
    return { item, lines, complete };
  }

  /**
   * Every matching line, oldest first. The ledger pages newest first only, so the matching lines are collected
   * newest first (bounded), reversed, and paged by how many have been shown. New postings are the newest, so they land
   * at the end of this order and never move a page boundary. Past the bound it refuses rather than show a short list.
   */
  private async listOldestFirst(userId: string, input: ActivityQuery): Promise<ActivityPage> {
    const { cursorSecret } = this.options;
    if (!this.options.pages || !cursorSecret) throw new ActivityUnavailableError();
    const base: ActivityQuery = { ...input, sort: undefined, cursor: undefined, limit: ACTIVITY_MAX_LIMIT };
    const filter = readFilter(base);
    const assetId = input.assetId ?? null;
    const filterKey = activityFilterKey(filter, 'asc');
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? ACTIVITY_DEFAULT_LIMIT), 1), ACTIVITY_MAX_LIMIT);
    const skip = input.cursor === undefined ? 0 : (decodeCursor(cursorSecret, input.cursor, { userId, assetId, filterKey }).skip ?? 0);

    const newestFirst: ActivityItem[] = [];
    let cursor: string | undefined;
    for (let call = 0; ; call += 1) {
      if (call >= ASC_MAX_CALLS) throw new ActivitySortBoundedError();
      const page = await this.listFiltered(userId, { ...base, ...(cursor === undefined ? {} : { cursor }) });
      newestFirst.push(...page.items);
      if (newestFirst.length > ASC_MAX_ITEMS) throw new ActivitySortBoundedError();
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const oldestFirst = newestFirst.reverse();
    const items = oldestFirst.slice(skip, skip + limit);
    const shown = skip + items.length;
    return {
      items,
      nextCursor: shown < oldestFirst.length ? encodeCursor(cursorSecret, { userId, assetId, owners: {}, filterKey, skip: shown }) : null,
    };
  }

  private async listPage(
    userId: string,
    input: { limit?: number; cursor?: string; assetId?: string; needAddress?: boolean; needNotes?: boolean },
  ): Promise<ActivityPage> {
    const { pages, cursorSecret } = this.options;
    if (!pages || !cursorSecret) throw new ActivityUnavailableError();

    const limit = Math.min(Math.max(Math.trunc(input.limit ?? ACTIVITY_DEFAULT_LIMIT), 1), ACTIVITY_MAX_LIMIT);
    const assetId = input.assetId ?? null;

    // Cursor first: a bad one is refused before anything is read.
    const resume = input.cursor === undefined ? null : decodeCursor(cursorSecret, input.cursor, { userId, assetId });

    const owners = await this.ownersOf(userId, assetId);
    const live = owners.filter((o) => (resume === null ? true : resume.owners[o.key] !== undefined && resume.owners[o.key] !== false));
    const start = (o: Owner): string | null => (resume === null ? null : (resume.owners[o.key] as string | null));

    const read = (o: Owner, cursor: string | null, n: number) =>
      pages.page({
        ownerType: o.ownerType,
        ownerId: o.ownerId,
        kind: 'available',
        ...(assetId === null ? {} : { assetId }),
        limit: n,
        ...(cursor === null ? {} : { cursor }),
      });

    try {
      const queues: Queue[] = [];
      for (let i = 0; i < live.length; i += FETCH_CONCURRENCY) {
        const batch = live.slice(i, i + FETCH_CONCURRENCY);
        const got = await Promise.all(batch.map((o) => read(o, start(o), limit)));
        batch.forEach((owner, j) =>
          queues.push({ owner, start: start(owner), entries: got[j]!.entries, next: got[j]!.nextCursor, taken: 0 }),
        );
      }

      const taken = this.merge(queues, limit);

      // Where each owner stopped.
      const positions: Record<string, OwnerPosition> = {};
      for (const q of queues) {
        if (q.taken === q.entries.length) {
          positions[q.owner.key] = q.next === null ? false : q.next;
        } else if (q.taken === 0) {
          positions[q.owner.key] = q.start;
        } else {
          const lastUsed = q.entries[q.taken - 1]!;
          if (lastUsed.entryId !== undefined) {
            // Exact: resume strictly below the last entry shown. Nothing is re-read.
            positions[q.owner.key] = ledgerCursorBelow(lastUsed.entryId);
          } else {
            // Ledger without entry ids: the cursor after exactly `taken` entries, by a re-read.
            const upto = await read(q.owner, q.start, q.taken);
            positions[q.owner.key] = upto.nextCursor ?? false;
          }
        }
      }

      const items = await this.toItems(userId, taken, input.needAddress === true, input.needNotes === true);
      const more = Object.values(positions).some((p) => p !== false);
      return { items, nextCursor: more ? encodeCursor(cursorSecret, { userId, assetId, owners: positions }) : null };
    } catch (err) {
      if (err instanceof ActivityCursorInvalidError) throw err;
      throw new ActivityUnavailableError();
    }
  }

  /** The caller's own account plus their named Spaces. Space ids come from svc-bank's table filtered by `user_id`. */
  private async ownersOf(userId: string, assetId: string | null): Promise<Owner[]> {
    const named = (await this.spaces.allNamedSpaces(userId, assetId ?? undefined)).filter((s) => s.kind === 'named' && s.userId === userId);
    if (named.length + 1 > ACTIVITY_MAX_OWNERS) throw new ActivityUnavailableError('Too many Spaces to merge into one feed');
    return [
      { key: 'u', ownerType: 'user', ownerId: userId, spaceName: null },
      ...named.map((s): Owner => ({ key: `s:${s.id}`, ownerType: 'subaccount', ownerId: s.id, spaceName: s.name })),
    ];
  }

  /**
   * One account is a view over the whole feed, not a narrower read: a move between two of the customer's own pots is
   * two ledger entries, and it only reads as a Space move when both halves are in hand. So every owner is read and the
   * lines of one account are kept. An id that is not `main` or one of the customer's own Spaces is refused here.
   */
  private async assertAccount(userId: string, assetId: string | null, accountId: string): Promise<void> {
    if (accountId === 'main') return;
    const owners = await this.ownersOf(userId, assetId);
    if (!owners.some((owner) => owner.key === `s:${accountId}`)) throw new ActivityAccountUnknownError();
  }

  /** k-way merge of the owners' newest-first queues. Each owner's own order is kept. */
  private merge(queues: Queue[], limit: number): Taken[] {
    const out: Taken[] = [];
    const head = (): Queue | undefined => {
      let best: Queue | undefined;
      for (const q of queues) {
        const e = q.entries[q.taken];
        if (e === undefined) continue;
        if (best === undefined || after(best.entries[best.taken]!, e) > 0) best = q;
      }
      return best;
    };
    const take = (q: Queue) => {
      out.push({ entry: q.entries[q.taken]!, queue: q });
      q.taken += 1;
    };

    while (out.length < limit) {
      const q = head();
      if (q === undefined) break;
      take(q);
    }
    // Never split a transaction whose other half is already in hand (a Space move is two entries).
    for (;;) {
      const q = head();
      const last = out[out.length - 1];
      if (q === undefined || last === undefined || q.entries[q.taken]!.txId !== last.entry.txId) break;
      take(q);
    }
    return out;
  }

  private async toItems(userId: string, taken: Taken[], needAddress = false, needNotes = false): Promise<ActivityItem[]> {
    // A transfer with both halves among the user's own pots is a Space move, not a payment to anyone.
    const transferHalves = new Map<string, number>();
    for (const { entry } of taken) {
      if (TRANSFER_REASONS.has(`${entry.module}/${entry.reason}`))
        transferHalves.set(entry.txId, (transferHalves.get(entry.txId) ?? 0) + 1);
    }

    const seen = new Map<string, number>();
    const items: ActivityItem[] = taken.map(({ entry, queue }) => {
      const dir = directionOf(entry.direction);
      const own = (transferHalves.get(entry.txId) ?? 0) >= 2;
      const base = `${entry.txId}:${queue.owner.key}:${entry.assetId}:${dir}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return {
        id: n === 0 ? base : `${base}#${n}`,
        kind: own ? 'space_move' : classify({ module: entry.module, reason: entry.reason, direction: entry.direction, rail: entry.rail }),
        direction: dir,
        asset: entry.assetId,
        amount: entry.amount,
        postedAt: entry.postedAt.toISOString(),
        txId: entry.txId,
        counterparty: null,
        spaceName: queue.owner.spaceName,
        ...(typeof entry.orderId === 'string' && entry.orderId !== '' ? { orderId: entry.orderId } : {}),
        ...(isPurchase(entry, dir) ? { purchase: true as const } : {}),
      };
    });

    const wanted = [...new Set(items.filter((i) => i.kind === 'transfer_in' || i.kind === 'transfer_out').map((i) => i.txId))];
    let withHandles = items;
    const resolver = this.options.counterparties;
    if (resolver !== undefined && wanted.length > 0) {
      try {
        const handles = await resolver.handlesFor(userId, wanted);
        withHandles = items.map((i) => {
          const h = i.kind === 'transfer_in' || i.kind === 'transfer_out' ? handles.get(i.txId) : undefined;
          return h === undefined ? i : { ...i, counterparty: { handle: h.handle } };
        });
      } catch {
        // A handle is a nicety. Failing to find one never hides the money movement.
      }
    }
    const personalTx = new Set<string>();
    const facts = this.options.transferFacts;
    if (facts !== undefined && wanted.length > 0) {
      try {
        const recorded = await facts.forTransfers(userId, wanted);
        withHandles = withHandles.map((i) => {
          const fact = i.kind === 'transfer_in' || i.kind === 'transfer_out' ? recorded.get(i.txId) : undefined;
          if (fact === undefined) return i;
          personalTx.add(i.txId);
          return {
            ...i,
            ...(fact.counterpartyHandle ? { counterparty: { handle: fact.counterpartyHandle } } : {}),
            ...(fact.note ? { note: fact.note } : {}),
            ...(fact.reference ? { reference: fact.reference } : {}),
          };
        });
      } catch {
        // A missing note never hides the money movement.
      }
    }
    return this.withRecords(userId, withHandles, personalTx, needAddress, needNotes);
  }

  /**
   * A withdrawal's recorded address. Only withdrawal lines can have one. A failed lookup never hides a line, except
   * when the caller is filtering by address: then it fails the read, because a filter that quietly missed a line would
   * be a plausible list with money missing from it.
   */
  private async withAddresses(
    userId: string,
    items: ActivityItem[],
    records: NonNullable<ActivityServiceOptions['records']>,
    needAddress: boolean,
  ): Promise<ActivityItem[]> {
    const lookup = records.addressesFor;
    if (!lookup) {
      if (needAddress) throw new ActivityUnavailableError();
      return items;
    }
    const txIds = [...new Set(items.filter((item) => item.kind === 'withdrawal').map((item) => item.txId))];
    if (txIds.length === 0) return items;
    try {
      const found = await lookup.call(records, userId, txIds);
      return items.map((item) => {
        const address = item.kind === 'withdrawal' ? found.get(item.txId) : undefined;
        return address === undefined ? item : { ...item, address };
      });
    } catch {
      if (needAddress) throw new ActivityUnavailableError();
      return items;
    }
  }

  /**
   * A personal send already took its note and reference from `transferFacts`.
   * A space-to-space transfer takes those two fields from `transfer_messages`.
   * Private notes and disputes are the caller's own, on either kind of line.
   */
  private async withRecords(
    userId: string,
    items: ActivityItem[],
    personalTx: ReadonlySet<string>,
    needAddress: boolean,
    needNotes: boolean,
  ): Promise<ActivityItem[]> {
    const records = this.options.records;
    if (!records) {
      if (needAddress || needNotes) throw new ActivityUnavailableError();
      return items;
    }
    if (items.length === 0) return items;
    items = await this.withAddresses(userId, items, records, needAddress);
    let notes: ReadonlyMap<string, ActivityAnnotation>;
    try {
      notes = await records.forItems(
        userId,
        items.map((item) => ({ id: item.id, txId: item.txId })),
      );
    } catch {
      // A note is a nicety, except when the caller filters by it: a list that quietly missed a note would look right.
      if (needNotes) throw new ActivityUnavailableError();
      return items;
    }
    return items.map((item) => {
      const note = notes.get(item.id);
      if (!note) return item;
      const personal = personalTx.has(item.txId);
      return {
        ...item,
        ...(!personal && note.note ? { note: note.note } : {}),
        ...(!personal && note.reference ? { reference: note.reference } : {}),
        ...(note.privateNote ? { privateNote: note.privateNote } : {}),
        ...(note.reportDescription ? { reportDescription: note.reportDescription } : {}),
        ...(note.dispute ? { dispute: note.dispute } : {}),
      };
    });
  }
}
