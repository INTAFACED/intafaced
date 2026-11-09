import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';

/**
 * Our own record of the outside venue's markets INTAFACED shows (J-cex-spot-16): a versioned listing line per
 * (venue, symbol) holding the opening time, our routing state and a scheduled delisting; a versioned line of our largest
 * routed order; and the one dated customer notice a delisting sends. Tables in drizzle/20261109140659_venue_listings.sql.
 *
 * Every version is append-only and carries the approval that wrote it (its business key), the proposer and the approver.
 * A version is written only when the line's latest is the one before it, so two approved changes against the same
 * version cannot both land. Nothing here is a balance or an order.
 */

export type VenueRoutingState = 'show' | 'close_only' | 'stop';
export const VENUE_ROUTING_STATES: readonly VenueRoutingState[] = ['show', 'close_only', 'stop'];
export type VenueListingChange = 'listing' | 'routing' | 'delisting';

export interface VenueListingVersion {
  readonly venueId: string;
  readonly symbol: string;
  readonly version: number;
  readonly change: VenueListingChange;
  readonly opensAt: Date;
  readonly delistsAt: Date | null;
  readonly routing: VenueRoutingState;
  readonly approvalId: string;
  readonly proposerId: string;
  readonly approverId: string;
  readonly executorId: string;
  readonly reason: string;
  readonly recordedAt: Date;
}

export interface VenueLimitVersion {
  readonly venueId: string;
  readonly symbol: string;
  readonly version: number;
  readonly maxOrderQty: Amount;
  readonly maxOrderNotional: Amount;
  /** The venue's own largest order this version was checked against when written. */
  readonly venueMaxOrderQty: Amount;
  readonly venueMaxOrderNotional: Amount;
  readonly approvalId: string;
  readonly proposerId: string;
  readonly approverId: string;
  readonly executorId: string;
  readonly reason: string;
  readonly recordedAt: Date;
}

export interface VenueDelistingNotice {
  /** `venue-delisting:<venueId>:<symbol>:<delistsAt ISO>`: the one notice per market and date. */
  readonly noticeKey: string;
  readonly approvalId: string;
  readonly venueId: string;
  readonly symbol: string;
  readonly delistsAt: Date;
  readonly scheduledAt: Date;
  readonly publishedAt: Date | null;
}

/** `written`: this call wrote it. `replayed`: this approval already wrote a version. `stale`: another version is latest. */
export type AppendOutcome = 'written' | 'replayed' | 'stale';

export interface VenueListingStore {
  /** Every listing version of a venue, by symbol then version. */
  listingVersions(venueId: string): Promise<readonly VenueListingVersion[]>;
  latestListing(venueId: string, symbol: string): Promise<VenueListingVersion | null>;
  listingByApproval(approvalId: string): Promise<VenueListingVersion | null>;
  /** Every limit version of a venue, by symbol then version. */
  limitVersions(venueId: string): Promise<readonly VenueLimitVersion[]>;
  latestLimits(venueId: string, symbol: string): Promise<VenueLimitVersion | null>;
  limitsByApproval(approvalId: string): Promise<VenueLimitVersion | null>;
  /** Append `row` (its version is the latest + 1) and, in the same transaction, the delisting notice it sends. */
  appendListing(row: VenueListingVersion, notice?: Omit<VenueDelistingNotice, 'publishedAt'>): Promise<AppendOutcome>;
  appendLimits(row: VenueLimitVersion): Promise<AppendOutcome>;
  noticeByApproval(approvalId: string): Promise<VenueDelistingNotice | null>;
  /** Notices not yet published, oldest first. */
  pendingNotices(limit: number): Promise<readonly VenueDelistingNotice[]>;
  markNoticePublished(noticeKey: string, at: Date): Promise<void>;
}

export function delistingNoticeKey(venueId: string, symbol: string, delistsAt: Date): string {
  return `venue-delisting:${venueId}:${symbol}:${delistsAt.toISOString()}`;
}

/** In-process store with the same version and approval rules as Postgres (tests). */
export class MemoryVenueListingStore implements VenueListingStore {
  private readonly listings: VenueListingVersion[] = [];
  private readonly limits: VenueLimitVersion[] = [];
  private readonly notices = new Map<string, VenueDelistingNotice>();

  private static order<T extends { symbol: string; version: number }>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.version - b.version));
  }

  async listingVersions(venueId: string) {
    return MemoryVenueListingStore.order(this.listings.filter((r) => r.venueId === venueId));
  }
  async latestListing(venueId: string, symbol: string) {
    return (await this.listingVersions(venueId)).filter((r) => r.symbol === symbol).at(-1) ?? null;
  }
  async listingByApproval(approvalId: string) {
    return this.listings.find((r) => r.approvalId === approvalId) ?? null;
  }
  async limitVersions(venueId: string) {
    return MemoryVenueListingStore.order(this.limits.filter((r) => r.venueId === venueId));
  }
  async latestLimits(venueId: string, symbol: string) {
    return (await this.limitVersions(venueId)).filter((r) => r.symbol === symbol).at(-1) ?? null;
  }
  async limitsByApproval(approvalId: string) {
    return this.limits.find((r) => r.approvalId === approvalId) ?? null;
  }
  async appendListing(row: VenueListingVersion, notice?: Omit<VenueDelistingNotice, 'publishedAt'>): Promise<AppendOutcome> {
    if (this.listings.some((r) => r.approvalId === row.approvalId)) return 'replayed';
    const latest = await this.latestListing(row.venueId, row.symbol);
    if ((latest?.version ?? 0) !== row.version - 1) return 'stale';
    if (notice && this.notices.has(notice.noticeKey)) return 'stale';
    this.listings.push(row);
    if (notice) this.notices.set(notice.noticeKey, { ...notice, publishedAt: null });
    return 'written';
  }
  async appendLimits(row: VenueLimitVersion): Promise<AppendOutcome> {
    if (this.limits.some((r) => r.approvalId === row.approvalId)) return 'replayed';
    const latest = await this.latestLimits(row.venueId, row.symbol);
    if ((latest?.version ?? 0) !== row.version - 1) return 'stale';
    this.limits.push(row);
    return 'written';
  }
  async noticeByApproval(approvalId: string) {
    return [...this.notices.values()].find((n) => n.approvalId === approvalId) ?? null;
  }
  async pendingNotices(limit: number) {
    return [...this.notices.values()]
      .filter((n) => n.publishedAt === null)
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
      .slice(0, limit);
  }
  async markNoticePublished(noticeKey: string, at: Date) {
    const n = this.notices.get(noticeKey);
    if (n && n.publishedAt === null) this.notices.set(noticeKey, { ...n, publishedAt: at });
  }
}

type ListingRow = {
  venue_id: string;
  symbol: string;
  version: number;
  change: VenueListingChange;
  opens_at: Date;
  delists_at: Date | null;
  routing: VenueRoutingState;
  approval_id: string;
  proposer_id: string;
  approver_id: string;
  executor_id: string;
  reason: string;
  recorded_at: Date;
};
type LimitRow = {
  venue_id: string;
  symbol: string;
  version: number;
  max_order_qty: string;
  max_order_notional: string;
  venue_max_order_qty: string;
  venue_max_order_notional: string;
  approval_id: string;
  proposer_id: string;
  approver_id: string;
  executor_id: string;
  reason: string;
  recorded_at: Date;
};
type NoticeRow = {
  notice_key: string;
  approval_id: string;
  venue_id: string;
  symbol: string;
  delists_at: Date;
  scheduled_at: Date;
  published_at: Date | null;
};

const listingOf = (r: ListingRow): VenueListingVersion => ({
  venueId: r.venue_id,
  symbol: r.symbol,
  version: Number(r.version),
  change: r.change,
  opensAt: new Date(r.opens_at),
  delistsAt: r.delists_at ? new Date(r.delists_at) : null,
  routing: r.routing,
  approvalId: r.approval_id,
  proposerId: r.proposer_id,
  approverId: r.approver_id,
  executorId: r.executor_id,
  reason: r.reason,
  recordedAt: new Date(r.recorded_at),
});
const limitOf = (r: LimitRow): VenueLimitVersion => ({
  venueId: r.venue_id,
  symbol: r.symbol,
  version: Number(r.version),
  maxOrderQty: parseAmount(r.max_order_qty),
  maxOrderNotional: parseAmount(r.max_order_notional),
  venueMaxOrderQty: parseAmount(r.venue_max_order_qty),
  venueMaxOrderNotional: parseAmount(r.venue_max_order_notional),
  approvalId: r.approval_id,
  proposerId: r.proposer_id,
  approverId: r.approver_id,
  executorId: r.executor_id,
  reason: r.reason,
  recordedAt: new Date(r.recorded_at),
});
const noticeOf = (r: NoticeRow): VenueDelistingNotice => ({
  noticeKey: r.notice_key,
  approvalId: r.approval_id,
  venueId: r.venue_id,
  symbol: r.symbol,
  delistsAt: new Date(r.delists_at),
  scheduledAt: new Date(r.scheduled_at),
  publishedAt: r.published_at ? new Date(r.published_at) : null,
});

const LISTING_COLUMNS = `venue_id, symbol, version, change, opens_at, delists_at, routing, approval_id, proposer_id, approver_id,
  executor_id, reason, recorded_at`;
const LIMIT_COLUMNS = `venue_id, symbol, version, max_order_qty::text AS max_order_qty, max_order_notional::text AS max_order_notional,
  venue_max_order_qty::text AS venue_max_order_qty, venue_max_order_notional::text AS venue_max_order_notional, approval_id,
  proposer_id, approver_id, executor_id, reason, recorded_at`;

export class SqlVenueListingStore implements VenueListingStore {
  constructor(private readonly sql: Sql) {}

  async listingVersions(venueId: string) {
    const rows = await this.sql<
      ListingRow[]
    >`SELECT ${this.sql.unsafe(LISTING_COLUMNS)} FROM trade.venue_listings WHERE venue_id = ${venueId} ORDER BY symbol, version`;
    return rows.map(listingOf);
  }
  async latestListing(venueId: string, symbol: string) {
    const rows = await this.sql<
      ListingRow[]
    >`SELECT ${this.sql.unsafe(LISTING_COLUMNS)} FROM trade.venue_listings WHERE venue_id = ${venueId} AND symbol = ${symbol} ORDER BY version DESC LIMIT 1`;
    return rows[0] ? listingOf(rows[0]) : null;
  }
  async listingByApproval(approvalId: string) {
    const rows = await this.sql<
      ListingRow[]
    >`SELECT ${this.sql.unsafe(LISTING_COLUMNS)} FROM trade.venue_listings WHERE approval_id = ${approvalId}`;
    return rows[0] ? listingOf(rows[0]) : null;
  }
  async limitVersions(venueId: string) {
    const rows = await this.sql<
      LimitRow[]
    >`SELECT ${this.sql.unsafe(LIMIT_COLUMNS)} FROM trade.venue_routed_limits WHERE venue_id = ${venueId} ORDER BY symbol, version`;
    return rows.map(limitOf);
  }
  async latestLimits(venueId: string, symbol: string) {
    const rows = await this.sql<
      LimitRow[]
    >`SELECT ${this.sql.unsafe(LIMIT_COLUMNS)} FROM trade.venue_routed_limits WHERE venue_id = ${venueId} AND symbol = ${symbol} ORDER BY version DESC LIMIT 1`;
    return rows[0] ? limitOf(rows[0]) : null;
  }
  async limitsByApproval(approvalId: string) {
    const rows = await this.sql<
      LimitRow[]
    >`SELECT ${this.sql.unsafe(LIMIT_COLUMNS)} FROM trade.venue_routed_limits WHERE approval_id = ${approvalId}`;
    return rows[0] ? limitOf(rows[0]) : null;
  }

  async appendListing(row: VenueListingVersion, notice?: Omit<VenueDelistingNotice, 'publishedAt'>): Promise<AppendOutcome> {
    return (await this.sql
      .begin(async (txn) => {
        const tx = txn as unknown as Sql;
        // Only on top of the version before it: a concurrent write of the same version loses on the primary key.
        const inserted = await tx<Array<{ version: number }>>`
        INSERT INTO trade.venue_listings (venue_id, symbol, version, change, opens_at, delists_at, routing, approval_id,
          proposer_id, approver_id, executor_id, reason, recorded_at)
        SELECT ${row.venueId}, ${row.symbol}, ${row.version}, ${row.change}, ${row.opensAt}, ${row.delistsAt}, ${row.routing},
          ${row.approvalId}, ${row.proposerId}, ${row.approverId}, ${row.executorId}, ${row.reason}, ${row.recordedAt}
        WHERE COALESCE((SELECT max(version) FROM trade.venue_listings WHERE venue_id = ${row.venueId} AND symbol = ${row.symbol}), 0)
              = ${row.version - 1}
        ON CONFLICT DO NOTHING
        RETURNING version`;
        if (inserted.length === 0) {
          const [byApproval] = await tx<
            Array<{ one: number }>
          >`SELECT 1 AS one FROM trade.venue_listings WHERE approval_id = ${row.approvalId}`;
          return byApproval ? 'replayed' : 'stale';
        }
        if (notice) {
          const sent = await tx<Array<{ notice_key: string }>>`
          INSERT INTO trade.venue_delisting_notices (notice_key, approval_id, venue_id, symbol, delists_at, scheduled_at)
          VALUES (${notice.noticeKey}, ${notice.approvalId}, ${notice.venueId}, ${notice.symbol}, ${notice.delistsAt}, ${notice.scheduledAt})
          ON CONFLICT DO NOTHING
          RETURNING notice_key`;
          // A notice under this key already exists (another approval scheduled the same date): undo the version too.
          if (sent.length === 0) throw new StaleNotice();
        }
        return 'written';
      })
      .catch((err: unknown) => {
        if (err instanceof StaleNotice) return 'stale';
        throw err;
      })) as AppendOutcome;
  }

  async appendLimits(row: VenueLimitVersion): Promise<AppendOutcome> {
    const inserted = await this.sql<Array<{ version: number }>>`
      INSERT INTO trade.venue_routed_limits (venue_id, symbol, version, max_order_qty, max_order_notional, venue_max_order_qty,
        venue_max_order_notional, approval_id, proposer_id, approver_id, executor_id, reason, recorded_at)
      SELECT ${row.venueId}, ${row.symbol}, ${row.version}, ${formatAmount(row.maxOrderQty)}::numeric,
        ${formatAmount(row.maxOrderNotional)}::numeric, ${formatAmount(row.venueMaxOrderQty)}::numeric,
        ${formatAmount(row.venueMaxOrderNotional)}::numeric, ${row.approvalId}, ${row.proposerId}, ${row.approverId},
        ${row.executorId}, ${row.reason}, ${row.recordedAt}
      WHERE COALESCE((SELECT max(version) FROM trade.venue_routed_limits WHERE venue_id = ${row.venueId} AND symbol = ${row.symbol}), 0)
            = ${row.version - 1}
      ON CONFLICT DO NOTHING
      RETURNING version`;
    if (inserted.length > 0) return 'written';
    const [byApproval] = await this.sql<
      Array<{ one: number }>
    >`SELECT 1 AS one FROM trade.venue_routed_limits WHERE approval_id = ${row.approvalId}`;
    return byApproval ? 'replayed' : 'stale';
  }

  async noticeByApproval(approvalId: string) {
    const rows = await this.sql<NoticeRow[]>`
      SELECT notice_key, approval_id, venue_id, symbol, delists_at, scheduled_at, published_at
        FROM trade.venue_delisting_notices WHERE approval_id = ${approvalId}`;
    return rows[0] ? noticeOf(rows[0]) : null;
  }
  async pendingNotices(limit: number) {
    const rows = await this.sql<NoticeRow[]>`
      SELECT notice_key, approval_id, venue_id, symbol, delists_at, scheduled_at, published_at
        FROM trade.venue_delisting_notices WHERE published_at IS NULL ORDER BY scheduled_at, notice_key LIMIT ${limit}`;
    return rows.map(noticeOf);
  }
  async markNoticePublished(noticeKey: string, at: Date) {
    await this.sql`UPDATE trade.venue_delisting_notices SET published_at = ${at} WHERE notice_key = ${noticeKey} AND published_at IS NULL`;
  }
}

class StaleNotice extends Error {}

/**
 * Tests only: a memory store where `symbols` on `venueId` are listed (version 1, routing `show`, open since `opensAt`),
 * recorded as a TEST fixture, so a door test that is about something else sees its markets.
 */
export function listedTestStore(
  symbols: readonly string[],
  venueId = 'test-venue-sim',
  opensAt = new Date('2026-01-01T00:00:00.000Z'),
): MemoryVenueListingStore {
  const store = new MemoryVenueListingStore();
  for (const symbol of symbols) {
    void store.appendListing({
      venueId,
      symbol,
      version: 1,
      change: 'listing',
      opensAt,
      delistsAt: null,
      routing: 'show',
      approvalId: `test-stack-listing:${venueId}:${symbol}`,
      proposerId: 'TEST fixture',
      approverId: 'TEST fixture',
      executorId: 'TEST fixture',
      reason: 'TEST fixture listing',
      recordedAt: opensAt,
    });
  }
  return store;
}
