import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { FeeShareAttribution } from './fee-share.js';
import type { FundPlan, NewVenueShare, VenueFeeShareStore, VenueShareRow } from './venue-fee-share.js';

/**
 * Where venue-fee-share.ts keeps its rows: svc-trade's own `copy_settled_fee_shares` (venue columns,
 * drizzle/20261120140000_copy_venue_fee_shares.sql), `copy_period_stats` (the pair's cap, as the TEST-book path counts it)
 * and `copy_fee_share_funds`. Never a balance: the ledger is the record of what is set aside and owed.
 */

const when = z.union([z.date(), z.string()]).transform((v) => (v instanceof Date ? v : new Date(v)));
const ShareRow = z.object({
  fill_id: z.string(),
  follow_id: z.string(),
  leader_id: z.string(),
  venue_id: z.string(),
  venue_account: z.string(),
  venue_fill_id: z.string(),
  asset_id: z.string(),
  protocol_fee: z.string(),
  applied_share_bps: z.number().int(),
  capped_leader_share: z.string(),
  filled_at: when,
  claim_id: z.string().nullable(),
});
const FundRow = z.object({
  venue_id: z.string(),
  claim_id: z.string(),
  asset_id: z.string(),
  claim_amount: z.string(),
  amount: z.string(),
  status: z.enum(['planned', 'posted']),
});
const IdRow = z.object({ fill_id: z.string() });
const StatsRow = z.object({ earnings_paid: z.string(), round_trips: z.number().int() });
const TaggedRow = z.object({ fill_id: z.string(), capped_leader_share: z.string() });

const toShare = (r: z.infer<typeof ShareRow>): VenueShareRow => ({
  rowId: r.fill_id,
  followId: r.follow_id,
  leaderId: r.leader_id,
  venueId: r.venue_id,
  venueAccount: r.venue_account,
  venueFillId: r.venue_fill_id,
  assetId: r.asset_id,
  feeEarned: parseAmount(r.protocol_fee),
  appliedShareBps: r.applied_share_bps,
  amount: parseAmount(r.capped_leader_share),
  filledAt: r.filled_at,
  claimId: r.claim_id,
});

const toPlan = (r: z.infer<typeof FundRow>): FundPlan => ({
  venueId: r.venue_id,
  claimId: r.claim_id,
  assetId: r.asset_id,
  claimAmount: parseAmount(r.claim_amount),
  amount: parseAmount(r.amount),
  status: r.status,
});

const SHARE_COLUMNS = `s.fill_id, s.follow_id, s.leader_id, s.venue_id, s.venue_account, s.venue_fill_id, s.asset_id,
  s.protocol_fee::text AS protocol_fee, s.applied_share_bps, s.capped_leader_share::text AS capped_leader_share, s.filled_at, s.claim_id`;
const FUND_COLUMNS = `venue_id, claim_id, asset_id, claim_amount::text AS claim_amount, amount::text AS amount, status`;

export class SqlVenueFeeShareStore implements VenueFeeShareStore {
  constructor(private readonly sql: Sql) {}

  async recorded(rowIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (rowIds.length === 0) return new Set();
    const rows = IdRow.array().parse(
      await this.sql`SELECT fill_id FROM trade.copy_settled_fee_shares WHERE fill_id = ANY(${[...rowIds]}::text[])`,
    );
    return new Set(rows.map((r) => r.fill_id));
  }

  async record(
    share: NewVenueShare,
    compute: (period: { earningsPaid: Amount; roundTrips: number }) => FeeShareAttribution,
  ): Promise<'recorded' | 'exists'> {
    const pairKey = `${share.leaderId}:${share.followerId}`;
    let outcome: 'recorded' | 'exists' = 'exists';
    await this.sql.begin(async (tx) => {
      const had = IdRow.array().parse(await tx`SELECT fill_id FROM trade.copy_settled_fee_shares WHERE fill_id = ${share.rowId}`);
      if (had.length > 0) return;
      await tx`
        INSERT INTO trade.copy_period_stats (pair_key, earnings_paid, round_trips, updated_at)
        VALUES (${pairKey}, 0, 0, now())
        ON CONFLICT (pair_key) DO NOTHING`;
      const [stats] = StatsRow.array().parse(
        await tx`SELECT earnings_paid::text AS earnings_paid, round_trips FROM trade.copy_period_stats WHERE pair_key = ${pairKey} FOR UPDATE`,
      );
      if (!stats) throw new Error(`copy_period_stats has no row for ${pairKey} after its insert`);
      const a = compute({ earningsPaid: parseAmount(stats.earnings_paid), roundTrips: stats.round_trips });
      const inserted = IdRow.array().parse(
        await tx`
          INSERT INTO trade.copy_settled_fee_shares (
            follow_id, fill_id, leader_id, follower_id, asset_id, protocol_fee, applied_share_bps, gross_leader_share,
            capped_leader_share, skipped_reason, settled, created_at,
            venue_id, venue_account, venue_fill_id, leader_fill_id, filled_at
          ) VALUES (
            ${share.followId}, ${share.rowId}, ${share.leaderId}, ${share.followerId}, ${share.assetId},
            ${formatAmount(a.protocolFee)}, ${a.appliedShareBps}, ${formatAmount(a.grossLeaderShare)},
            ${formatAmount(a.cappedLeaderShare)}, ${a.skippedReason}, false, now(),
            ${share.venueId}, ${share.venueAccount}, ${share.venueFillId}, ${share.leaderFillId}, ${share.filledAt}
          )
          ON CONFLICT DO NOTHING
          RETURNING fill_id`,
      );
      if (inserted.length === 0) return;
      // Counted against the pair's cap with the row, so two runs can never both pass one reading of it.
      await tx`
        UPDATE trade.copy_period_stats
           SET earnings_paid = earnings_paid + ${formatAmount(a.cappedLeaderShare)}::numeric,
               round_trips = round_trips + 1,
               updated_at = now()
         WHERE pair_key = ${pairKey}`;
      outcome = 'recorded';
    });
    return outcome;
  }

  async fundPlan(venueId: string, claimId: string): Promise<FundPlan | null> {
    const [row] = FundRow.array().parse(
      await this
        .sql`SELECT ${this.sql.unsafe(FUND_COLUMNS)} FROM trade.copy_fee_share_funds WHERE venue_id = ${venueId} AND claim_id = ${claimId}`,
    );
    return row ? toPlan(row) : null;
  }

  async unfunded(venueId: string, assetId: string, through: Date): Promise<VenueShareRow[]> {
    const rows = ShareRow.array().parse(
      await this.sql`
        SELECT ${this.sql.unsafe(SHARE_COLUMNS)}
          FROM trade.copy_settled_fee_shares s
         WHERE s.venue_id = ${venueId} AND s.asset_id = ${assetId} AND s.claim_id IS NULL
           AND s.skipped_reason IS NULL AND s.capped_leader_share > 0 AND s.filled_at <= ${through}
         ORDER BY s.filled_at ASC, s.fill_id ASC`,
    );
    return rows.map(toShare);
  }

  async planFund(plan: FundPlan, rowIds: readonly string[]): Promise<FundPlan> {
    let stored: FundPlan = plan;
    await this.sql.begin(async (tx) => {
      const inserted = FundRow.pick({ claim_id: true })
        .array()
        .parse(
          await tx`
            INSERT INTO trade.copy_fee_share_funds (venue_id, claim_id, asset_id, claim_amount, amount, status)
            VALUES (${plan.venueId}, ${plan.claimId}, ${plan.assetId}, ${formatAmount(plan.claimAmount)}, ${formatAmount(plan.amount)}, 'planned')
            ON CONFLICT (venue_id, claim_id) DO NOTHING
            RETURNING claim_id`,
        );
      if (inserted.length === 0) {
        const [row] = FundRow.array().parse(
          await tx`SELECT ${tx.unsafe(FUND_COLUMNS)} FROM trade.copy_fee_share_funds WHERE venue_id = ${plan.venueId} AND claim_id = ${plan.claimId}`,
        );
        if (row) stored = toPlan(row);
        return;
      }
      const tagged = TaggedRow.array().parse(
        await tx`
          UPDATE trade.copy_settled_fee_shares SET claim_id = ${plan.claimId}
           WHERE fill_id = ANY(${[...rowIds]}::text[]) AND claim_id IS NULL AND venue_id = ${plan.venueId}
          RETURNING fill_id, capped_leader_share::text AS capped_leader_share`,
      );
      const sum = tagged.reduce((s, r) => s + parseAmount(r.capped_leader_share), 0n);
      // Another run covered one of these rows first: this plan is not stored, and the next run plans again.
      if (tagged.length !== rowIds.length || sum !== plan.amount) throw new Error('fee-share fund plan raced another run; not stored');
    });
    return stored;
  }

  async markFundPosted(venueId: string, claimId: string, ledgerTxId: string): Promise<void> {
    await this.sql`
      UPDATE trade.copy_fee_share_funds SET status = 'posted', ledger_tx_id = ${ledgerTxId}
       WHERE venue_id = ${venueId} AND claim_id = ${claimId} AND status = 'planned'`;
  }

  async owing(): Promise<VenueShareRow[]> {
    const rows = ShareRow.array().parse(
      await this.sql`
        SELECT ${this.sql.unsafe(SHARE_COLUMNS)}
          FROM trade.copy_settled_fee_shares s
          JOIN trade.copy_fee_share_funds f ON f.venue_id = s.venue_id AND f.claim_id = s.claim_id AND f.status = 'posted'
         WHERE s.settled = false AND s.skipped_reason IS NULL AND s.capped_leader_share > 0
         ORDER BY s.filled_at ASC, s.fill_id ASC`,
    );
    return rows.map(toShare);
  }

  async markOwed(rowId: string, ledgerTxId: string): Promise<void> {
    await this.sql`
      UPDATE trade.copy_settled_fee_shares SET settled = true, owe_tx_id = ${ledgerTxId}
       WHERE fill_id = ${rowId} AND settled = false AND claim_id IS NOT NULL`;
  }
}
