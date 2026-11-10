import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { UserVenueAccount } from '@intafaced/venue-contracts';

/**
 * The account part of a builder fee's ledger key (OWNER 288 change 1a): the owner, or `<owner>/<subAccount>`. The two
 * sides of one trade can be two of our accounts under one fill id, so the key and the store's row name the account.
 */
export function builderFeeVenueAccount(account: Pick<UserVenueAccount, 'owner' | 'subAccount'>): string {
  return account.subAccount === null ? account.owner : `${account.owner}/${account.subAccount}`;
}

/**
 * What became of one fill with a builder fee: posted to the ledger, refused by it, or `not_our_order`: the fill's order is
 * none our door stored before sending, so its builder fee is not ours and is never posted (OWNER 288 change 1b).
 */
export type LoggedBuilderFeeStatus = 'posted' | 'refused' | 'not_our_order';

/**
 * Which venue fills had our builder fee posted to the ledger, or refused by it, or were not ours (D-venue-07; OWNER 288).
 * `trade.venue_builder_fees` (drizzle/20261109120000_venue_builder_fees.sql, 20261110103326_builder_fee_account_key.sql),
 * one row per venue, account and fill. Never a balance: the ledger's own transaction under
 * `builder-fee:<venueId>:<venueAccount>:<fillId>` is the record of the fee earned, and the recon reads the amount from it.
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
  readonly status: LoggedBuilderFeeStatus;
  readonly refusalCode: string | null;
  readonly ledgerTxId: string | null;
}

/** Why a poster run stopped (OWNER 288 change 1c): the venue, and the account and fill it stopped at when it had reached one. */
export interface BuilderFeeStop {
  readonly venueId: string;
  /** The account part of the key (`builderFeeVenueAccount`), or null when the run stopped before reaching an account. */
  readonly venueAccount: string | null;
  readonly fillId: string | null;
  /** The failure's own code (`ledger.idempotency_conflict`, `ledger.frozen`, `venue.venue_down`), or `unknown`. */
  readonly code: string;
  readonly message: string;
}

/** The poster's runs on one venue: when it last completed one, and its last stop. */
export interface BuilderFeeRunState {
  readonly lastCompleteAt: Date | null;
  readonly lastStopAt: Date | null;
  readonly lastStop: BuilderFeeStop | null;
}

/** One of our users' accounts at a venue, with the time to read its fills from. */
export interface BuilderFeeAccount {
  readonly userId: string;
  readonly account: UserVenueAccount;
  readonly since: Date;
}

export interface BuilderFeeStore {
  /**
   * Our users' accounts on `venueId` that sent an order carrying our builder fee, once per venue account (under the user
   * who sent its first such order), each with the time to read fills from: a minute before the latest fill already
   * recorded for it, else its first such order.
   */
  accounts(venueId: string): Promise<BuilderFeeAccount[]>;
  /**
   * Record a fill's outcome, once per venue, account and fill. A posted fill stays posted; a refused or not-our-order one
   * is replaced by the next outcome.
   */
  record(row: LoggedBuilderFee, at: Date): Promise<void>;
  /** The recorded fills on `venueId` that filled in `[from, to)`, oldest first. */
  inPeriod(venueId: string, from: Date, to: Date): Promise<LoggedBuilderFee[]>;
  /** A poster run on `venueId` read every account and posted or recorded every fill. */
  markComplete(venueId: string, at: Date): Promise<void>;
  /** A poster run on `venueId` stopped. */
  markStopped(stop: BuilderFeeStop, at: Date): Promise<void>;
  runState(venueId: string): Promise<BuilderFeeRunState>;
}

const NO_RUNS: BuilderFeeRunState = { lastCompleteAt: null, lastStopAt: null, lastStop: null };
const rowId = (row: Pick<LoggedBuilderFee, 'venueId' | 'account' | 'fillId'>) =>
  `${row.venueId}\u0000${builderFeeVenueAccount(row.account)}\u0000${row.fillId}`;

/** Fills already read are read again for this long, so a fill the venue reports late is not missed; the key keeps it once. */
export const BUILDER_FEE_READ_OVERLAP_MS = 60_000;

export class InMemoryBuilderFeeStore implements BuilderFeeStore {
  readonly rows = new Map<string, LoggedBuilderFee>();
  readonly runs = new Map<string, BuilderFeeRunState>();
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

  async record(row: LoggedBuilderFee, _at?: Date): Promise<void> {
    const id = rowId(row);
    if (this.rows.get(id)?.status === 'posted') return;
    this.rows.set(id, row);
  }

  async markComplete(venueId: string, at: Date): Promise<void> {
    this.runs.set(venueId, { ...(this.runs.get(venueId) ?? NO_RUNS), lastCompleteAt: at });
  }

  async markStopped(stop: BuilderFeeStop, at: Date): Promise<void> {
    this.runs.set(stop.venueId, { ...(this.runs.get(stop.venueId) ?? NO_RUNS), lastStopAt: at, lastStop: stop });
  }

  async runState(venueId: string): Promise<BuilderFeeRunState> {
    return this.runs.get(venueId) ?? NO_RUNS;
  }

  async inPeriod(venueId: string, from: Date, to: Date): Promise<LoggedBuilderFee[]> {
    return [...this.rows.values()]
      .filter((r) => r.venueId === venueId && r.filledAt >= from && r.filledAt < to)
      .sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime() || a.fillId.localeCompare(b.fillId) || rowId(a).localeCompare(rowId(b)));
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
  status: LoggedBuilderFeeStatus;
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
        -- One row per venue account: a wallet that sent orders under two of our users is read once, under the user who
        -- sent its first one, so each fill posts under one key with one user.
        SELECT DISTINCT ON (owner, sub_account) user_id, owner, sub_account, first_at
        FROM (
          SELECT user_id, prepared->'account'->>'owner' AS owner, prepared->'account'->>'subAccount' AS sub_account,
                 min(created_at) AS first_at
          FROM trade.user_venue_actions
          WHERE venue_id = ${venueId} AND kind = 'place_order' AND signature IS NOT NULL
            AND prepared->'builderFee' IS NOT NULL AND jsonb_typeof(prepared->'builderFee') = 'object'
          GROUP BY 1, 2, 3
        ) per_user
        ORDER BY owner, sub_account, first_at, user_id
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
        (venue_id, venue_account, fill_id, user_id, owner, sub_account, asset_id, amount, filled_at, status, refusal_code,
         ledger_tx_id, recorded_at)
      VALUES (${row.venueId}, ${builderFeeVenueAccount(row.account)}, ${row.fillId}, ${row.userId}, ${row.account.owner},
              ${row.account.subAccount}, ${row.assetId}, ${formatAmount(row.amount)}, ${row.filledAt}, ${row.status},
              ${row.refusalCode}, ${row.ledgerTxId}, ${at})
      ON CONFLICT (venue_id, venue_account, fill_id) DO UPDATE SET
        status = EXCLUDED.status, refusal_code = EXCLUDED.refusal_code, ledger_tx_id = EXCLUDED.ledger_tx_id,
        recorded_at = EXCLUDED.recorded_at
      WHERE trade.venue_builder_fees.status <> 'posted'`;
  }

  async markComplete(venueId: string, at: Date): Promise<void> {
    await this.sql`
      INSERT INTO trade.venue_builder_fee_runs (venue_id, last_complete_at) VALUES (${venueId}, ${at})
      ON CONFLICT (venue_id) DO UPDATE SET last_complete_at = EXCLUDED.last_complete_at`;
  }

  async markStopped(stop: BuilderFeeStop, at: Date): Promise<void> {
    await this.sql`
      INSERT INTO trade.venue_builder_fee_runs (venue_id, last_stop_at, last_stop)
      VALUES (${stop.venueId}, ${at}, ${this.sql.json(stop as unknown as Parameters<Sql['json']>[0])})
      ON CONFLICT (venue_id) DO UPDATE SET last_stop_at = EXCLUDED.last_stop_at, last_stop = EXCLUDED.last_stop`;
  }

  async runState(venueId: string): Promise<BuilderFeeRunState> {
    const [row] = await this.sql<{ last_complete_at: Date | null; last_stop_at: Date | null; last_stop: BuilderFeeStop | null }[]>`
      SELECT last_complete_at, last_stop_at, last_stop FROM trade.venue_builder_fee_runs WHERE venue_id = ${venueId}`;
    return row ? { lastCompleteAt: row.last_complete_at, lastStopAt: row.last_stop_at, lastStop: row.last_stop } : NO_RUNS;
  }

  async inPeriod(venueId: string, from: Date, to: Date): Promise<LoggedBuilderFee[]> {
    const rows = await this.sql<Row[]>`
      SELECT venue_id, fill_id, user_id, owner, sub_account, asset_id, amount, filled_at, status, refusal_code, ledger_tx_id
      FROM trade.venue_builder_fees
      WHERE venue_id = ${venueId} AND filled_at >= ${from} AND filled_at < ${to}
      ORDER BY filled_at, fill_id, venue_account`;
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
