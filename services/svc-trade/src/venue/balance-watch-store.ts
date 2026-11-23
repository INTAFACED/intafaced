import type { Sql } from 'postgres';
import { z } from 'zod';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { UserVenueAccount } from '@intafaced/venue-contracts';

/**
 * The venue balance watch's cursor for one venue account (J-cex-spot-15 #9; balance-watch.ts):
 * `trade.user_venue_balance_watch_*` (drizzle/20261123170910_user_venue_balance_watch.sql). Not a balance of ours: the
 * venue's own totals the watch last reported, the venue records whose change it has published, and from when it reads
 * the account's fills. The ledger posts nothing.
 */
export interface BalanceWatchCursor {
  /** The venue's totals the watch last reported, by asset. */
  readonly totals: ReadonlyMap<string, Amount>;
  /** By asset: how many changes the venue reported no record for (the next one's number is this plus one). */
  readonly unreported: ReadonlyMap<string, number>;
  /** The venue records (`<kind>:<venue id>`) whose change was already published. */
  readonly seen: ReadonlySet<string>;
  /** From when the account's fills are read. */
  readonly fillsSince: Date;
}

export interface BalanceWatchStore {
  /** The account's cursor, or null when the watch has not yet taken its first reading of it. */
  read(account: UserVenueAccount): Promise<BalanceWatchCursor | null>;
  /**
   * Write the account's cursor after a reading: its totals and counts replace the old ones (an asset no longer held is
   * kept at zero), and `newlySeen` is added to what was seen. All of it, or none.
   */
  write(
    account: UserVenueAccount,
    next: { totals: ReadonlyMap<string, Amount>; unreported: ReadonlyMap<string, number>; fillsSince: Date },
    newlySeen: readonly string[],
  ): Promise<void>;
}

const keyOf = (a: UserVenueAccount) => `${a.venueId}\u0000${a.owner.toLowerCase()}\u0000${a.subAccount ?? ''}`;

export class InMemoryBalanceWatchStore implements BalanceWatchStore {
  private readonly rows = new Map<string, BalanceWatchCursor>();

  async read(account: UserVenueAccount) {
    return this.rows.get(keyOf(account)) ?? null;
  }

  async write(
    account: UserVenueAccount,
    next: { totals: ReadonlyMap<string, Amount>; unreported: ReadonlyMap<string, number>; fillsSince: Date },
    newlySeen: readonly string[],
  ) {
    const before = this.rows.get(keyOf(account));
    const totals = new Map(before?.totals ?? []);
    for (const [asset, total] of next.totals) totals.set(asset, total);
    const unreported = new Map(before?.unreported ?? []);
    for (const [asset, n] of next.unreported) unreported.set(asset, n);
    this.rows.set(keyOf(account), {
      totals,
      unreported,
      seen: new Set([...(before?.seen ?? []), ...newlySeen]),
      fillsSince: next.fillsSince,
    });
  }
}

const HeadRow = z.object({ fills_since: z.coerce.date() });
const TotalRow = z.object({ asset: z.string(), total: z.string(), unreported: z.number().int() });
const SeenRow = z.object({ record_id: z.string() });

export class SqlBalanceWatchStore implements BalanceWatchStore {
  constructor(private readonly sql: Sql) {}

  async read(account: UserVenueAccount): Promise<BalanceWatchCursor | null> {
    const venue = account.venueId;
    const owner = account.owner.toLowerCase();
    const sub = account.subAccount ?? '';
    const [head] = HeadRow.array().parse(
      await this.sql`
        SELECT fills_since FROM trade.user_venue_balance_watch_accounts
        WHERE venue_id = ${venue} AND owner = ${owner} AND sub_account = ${sub}`,
    );
    if (head === undefined) return null;
    const totals = TotalRow.array().parse(
      await this.sql`
        SELECT asset, total::text AS total, unreported FROM trade.user_venue_balance_watch_totals
        WHERE venue_id = ${venue} AND owner = ${owner} AND sub_account = ${sub}`,
    );
    const seen = SeenRow.array().parse(
      await this.sql`
        SELECT record_id FROM trade.user_venue_balance_watch_seen
        WHERE venue_id = ${venue} AND owner = ${owner} AND sub_account = ${sub}`,
    );
    return {
      totals: new Map(totals.map((r) => [r.asset, parseAmount(r.total)])),
      unreported: new Map(totals.map((r) => [r.asset, r.unreported])),
      seen: new Set(seen.map((r) => r.record_id)),
      fillsSince: head.fills_since,
    };
  }

  async write(
    account: UserVenueAccount,
    next: { totals: ReadonlyMap<string, Amount>; unreported: ReadonlyMap<string, number>; fillsSince: Date },
    newlySeen: readonly string[],
  ): Promise<void> {
    const venue = account.venueId;
    const owner = account.owner.toLowerCase();
    const sub = account.subAccount ?? '';
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO trade.user_venue_balance_watch_accounts (venue_id, owner, sub_account, fills_since)
        VALUES (${venue}, ${owner}, ${sub}, ${next.fillsSince})
        ON CONFLICT (venue_id, owner, sub_account) DO UPDATE SET fills_since = EXCLUDED.fills_since`;
      for (const [asset, total] of next.totals) {
        const unreported = next.unreported.get(asset) ?? 0;
        await tx`
          INSERT INTO trade.user_venue_balance_watch_totals (venue_id, owner, sub_account, asset, total, unreported)
          VALUES (${venue}, ${owner}, ${sub}, ${asset}, ${formatAmount(total)}, ${unreported})
          ON CONFLICT (venue_id, owner, sub_account, asset)
          DO UPDATE SET total = EXCLUDED.total, unreported = EXCLUDED.unreported`;
      }
      for (const id of newlySeen) {
        await tx`
          INSERT INTO trade.user_venue_balance_watch_seen (venue_id, owner, sub_account, record_id)
          VALUES (${venue}, ${owner}, ${sub}, ${id})
          ON CONFLICT DO NOTHING`;
      }
    });
  }
}
