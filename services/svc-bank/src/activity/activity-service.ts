import type { SpaceRecord } from '../spaces/space-service.js';
import { classify, directionOf, type ActivityKind, type EntryDirection } from './activity-kind.js';
import { ActivityCursorInvalidError, decodeCursor, encodeCursor, type OwnerPosition } from './activity-cursor.js';

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

export interface ActivityServiceOptions {
  /** Unset = every call refuses `ActivityUnavailableError`. Never an empty list. */
  pages?: LedgerHistoryPages;
  /** Signs page cursors. Required with `pages`. */
  cursorSecret?: string;
  counterparties?: ActivityCounterparties;
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
  async list(userId: string, input: { limit?: number; cursor?: string; assetId?: string }): Promise<ActivityPage> {
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

      const items = await this.toItems(userId, taken);
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

  private async toItems(userId: string, taken: Taken[]): Promise<ActivityItem[]> {
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
      };
    });

    const resolver = this.options.counterparties;
    const wanted = [...new Set(items.filter((i) => i.kind === 'transfer_in' || i.kind === 'transfer_out').map((i) => i.txId))];
    if (resolver === undefined || wanted.length === 0) return items;
    let handles: ReadonlyMap<string, { handle: string }>;
    try {
      handles = await resolver.handlesFor(userId, wanted);
    } catch {
      // A handle is a nicety. Failing to find one never hides the money movement.
      return items;
    }
    return items.map((i) => {
      const h = i.kind === 'transfer_in' || i.kind === 'transfer_out' ? handles.get(i.txId) : undefined;
      return h === undefined ? i : { ...i, counterparty: { handle: h.handle } };
    });
  }
}
