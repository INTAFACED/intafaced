import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { UserVenueAccount } from '@intafaced/venue-contracts';

/**
 * Which venue fills had our builder fee posted to the ledger, or refused by it (D-venue-07). `trade.venue_builder_fees`
 * (drizzle/20261109120000_venue_builder_fees.sql). Never a balance: the ledger's own transaction under
 * `builder-fee:<venueId>:<fillId>` is the record of the fee earned, and the recon reads the amount from it.
 */
export interface LoggedBuilderFee {
  readonly venueId: string;
  readonly fillId: string;
  readonly userId: string;
  readonly account: UserVenueAccount;
  readonly assetId: string;
  /** The venue's figure for the fee, as it was read. */
  readonly amount: Amount;
  readonly filledAt: Date;
  readonly status: 'posted' | 'refused';
  readonly refusalCode: string | null;
  readonly ledgerTxId: string | null;
}

/** One of our users' accounts at a venue, with the time to read its fills from. */
export interface BuilderFeeAccount {
  readonly userId: string;
  readonly account: UserVenueAccount;
  readonly since: Date;
}

export interface BuilderFeeStore {
  /**
   * Our users' accounts on `venueId` that sent an order carrying our builder fee, each with the time to read fills
   * from: a minute before the latest fill already recorded for it, else its first such order.
   */
  accounts(venueId: string): Promise<BuilderFeeAccount[]>;
  /** Record a fill's outcome. A posted fill stays posted; a refused one is replaced by the next outcome. */
  record(row: LoggedBuilderFee, at: Date): Promise<void>;
  /** The recorded fills on `venueId` that filled in `[from, to)`, oldest first. */
  inPeriod(venueId: string, from: Date, to: Date): Promise<LoggedBuilderFee[]>;
}

/** Fills already read are read again for this long, so a fill the venue reports late is not missed; the key keeps it once. */
export const BUILDER_FEE_READ_OVERLAP_MS = 60_000;

export class InMemoryBuilderFeeStore implements BuilderFeeStore {
  readonly rows = new Map<string, LoggedBuilderFee>();
  constructor(private readonly orderAccounts: () => BuilderFeeAccount[] = () => []) {}

  async accounts(venueId: string): Promise<BuilderFeeAccount[]> {
    return this.orderAccounts()
      .filter((a) => a.account.venueId === venueId)
      .map((a) => {
        const latest = [...this.rows.values()]
          .filter((r) => r.venueId === venueId && r.account.owner === a.account.owner && r.account.subAccount === a.account.subAccount)
          .reduce<number | null>((max, r) => (max === null || r.filledAt.getTime() > max ? r.filledAt.getTime() : max), null);
        return latest === null ? a : { ...a, since: new Date(latest - BUILDER_FEE_READ_OVERLAP_MS) };
      });
  }

  async record(row: LoggedBuilderFee): Promise<void> {
    const id = `${row.venueId}\u0000${row.fillId}`;
    if (this.rows.get(id)?.status === 'posted') return;
    this.rows.set(id, row);
  }

  async inPeriod(venueId: string, from: Date, to: Date): Promise<LoggedBuilderFee[]> {
    return [...this.rows.values()]
      .filter((r) => r.venueId === venueId && r.filledAt >= from && r.filledAt < to)
      .sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime() || a.fillId.localeCompare(b.fillId));
  }
}

interface Row {
  venue_id: string;
  fill_id: string;
  user_id: string;
  owner: string;
  sub_account: string | null;
  asset_id: string;
  amount: string;
  filled_at: Date;
  status: 'posted' | 'refused';
  refusal_code: string | null;
  ledger_tx_id: string | null;
}

export class SqlBuilderFeeStore implements BuilderFeeStore {
  constructor(private readonly sql: Sql) {}

  async accounts(venueId: string): Promise<BuilderFeeAccount[]> {
    const rows = await this.sql<{ user_id: string; owner: string; sub_account: string | null; first_at: Date; latest_fill: Date | null }[]>`
      SELECT a.user_id, a.owner, a.sub_account, a.first_at,
             (SELECT max(f.filled_at) FROM trade.venue_builder_fees f
               WHERE f.venue_id = ${venueId} AND f.owner = a.owner AND f.sub_account IS NOT DISTINCT FROM a.sub_account) AS latest_fill
      FROM (
        SELECT user_id, prepared->'account'->>'owner' AS owner, prepared->'account'->>'subAccount' AS sub_account,
               min(created_at) AS first_at
        FROM trade.user_venue_actions
        WHERE venue_id = ${venueId} AND kind = 'place_order' AND signature IS NOT NULL
          AND prepared->'builderFee' IS NOT NULL AND jsonb_typeof(prepared->'builderFee') = 'object'
        GROUP BY 1, 2, 3
      ) a
      ORDER BY a.first_at, a.owner`;
    return rows.map((r) => ({
      userId: r.user_id,
      account: { venueId, owner: r.owner, subAccount: r.sub_account },
      since: r.latest_fill ? new Date(r.latest_fill.getTime() - BUILDER_FEE_READ_OVERLAP_MS) : r.first_at,
    }));
  }

  async record(row: LoggedBuilderFee, at: Date): Promise<void> {
    await this.sql`
      INSERT INTO trade.venue_builder_fees
        (venue_id, fill_id, user_id, owner, sub_account, asset_id, amount, filled_at, status, refusal_code, ledger_tx_id, recorded_at)
      VALUES (${row.venueId}, ${row.fillId}, ${row.userId}, ${row.account.owner}, ${row.account.subAccount}, ${row.assetId},
              ${formatAmount(row.amount)}, ${row.filledAt}, ${row.status}, ${row.refusalCode}, ${row.ledgerTxId}, ${at})
      ON CONFLICT (venue_id, fill_id) DO UPDATE SET
        status = EXCLUDED.status, refusal_code = EXCLUDED.refusal_code, ledger_tx_id = EXCLUDED.ledger_tx_id,
        recorded_at = EXCLUDED.recorded_at
      WHERE trade.venue_builder_fees.status = 'refused'`;
  }

  async inPeriod(venueId: string, from: Date, to: Date): Promise<LoggedBuilderFee[]> {
    const rows = await this.sql<Row[]>`
      SELECT venue_id, fill_id, user_id, owner, sub_account, asset_id, amount, filled_at, status, refusal_code, ledger_tx_id
      FROM trade.venue_builder_fees
      WHERE venue_id = ${venueId} AND filled_at >= ${from} AND filled_at < ${to}
      ORDER BY filled_at, fill_id`;
    return rows.map((r) => ({
      venueId: r.venue_id,
      fillId: r.fill_id,
      userId: r.user_id,
      account: { venueId: r.venue_id, owner: r.owner, subAccount: r.sub_account },
      assetId: r.asset_id,
      amount: parseAmount(r.amount),
      filledAt: r.filled_at,
      status: r.status,
      refusalCode: r.refusal_code,
      ledgerTxId: r.ledger_tx_id,
    }));
  }
}
