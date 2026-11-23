/**
 * A follower's copied venue fills and what each one cost (J-copy-bots-otc-06 #1): the venue's fee and our builder fee as
 * the venue reports them on the fill, each named with its source, and the lead's share of our builder fee as svc-trade
 * recorded it (venue-fee-share.ts), paid by INTAFACED and never charged to the follower. Read only: nothing is posted.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import type { copyFeeShareStateSchema, myCopyFeesSchema } from '@intafaced/contracts/trade-copy-procedures';
import { MY_COPY_FEES_MAX } from '@intafaced/contracts/trade-copy-procedures';
import type { Sql } from 'postgres';
import { CopyError } from './errors.js';
import { venueFeeShareOweKey, venueFeeShareRowId, type VenueCopyFill } from './venue-fee-share.js';

export type MyCopyFees = z.infer<typeof myCopyFeesSchema>;
type FeeShareState = z.infer<typeof copyFeeShareStateSchema>;

/** A stored share, as this read needs it. */
export interface StoredCopyShare {
  readonly rowId: string;
  readonly leaderId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly appliedShareBps: number;
  readonly skippedReason: 'cap_reached' | 'zero_share' | null;
  readonly settled: boolean;
}

export interface MyCopyFeesDeps {
  readonly copiedFills: (followerId: string) => Promise<readonly VenueCopyFill[]>;
  readonly venueLabel: () => Promise<{ name: string; test: boolean }>;
  readonly shares: (rowIds: readonly string[]) => Promise<ReadonlyMap<string, StoredCopyShare>>;
  readonly leadName: (leaderId: string) => Promise<{ leaderRef: string; displayName: string } | null>;
  readonly now: () => Date;
}

/** Pure: what one fill's share comes to, from its builder fee and its stored row. */
export function feeShareState(fill: VenueCopyFill, share: StoredCopyShare | undefined): FeeShareState {
  if (fill.fill.builderFee <= 0n) return { state: 'none' };
  if (!share) return { state: 'recording' };
  if (share.skippedReason !== null) return { state: 'not_owed', reason: share.skippedReason };
  const money = { amount: formatAmount(parseAmount(share.amount)), asset: share.assetId };
  if (!share.settled) return { state: 'waiting_collection', share: money, shareBps: share.appliedShareBps };
  return {
    state: 'owed',
    share: money,
    shareBps: share.appliedShareBps,
    ledgerKey: venueFeeShareOweKey({
      venueId: fill.venueId,
      venueAccount: fill.venueAccount,
      venueFillId: fill.fill.fillId,
      leaderId: share.leaderId,
    }),
  };
}

export async function readMyCopyFees(deps: MyCopyFeesDeps, followerId: string, limit: number): Promise<MyCopyFees> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MY_COPY_FEES_MAX) {
    throw new CopyError(`limit must be a whole number from 1 to ${MY_COPY_FEES_MAX}`, 'trade.copy_limit_missing');
  }
  const fills = [...(await deps.copiedFills(followerId))]
    .sort((a, b) => b.fill.filledAt.getTime() - a.fill.filledAt.getTime() || (a.fill.fillId < b.fill.fillId ? 1 : -1))
    .slice(0, limit);
  const asOf = deps.now().toISOString();
  if (fills.length === 0) return { asOf, venue: null, rows: [] };
  const rowIdOf = (c: VenueCopyFill) => venueFeeShareRowId(c.venueId, c.venueAccount, c.fill.fillId);
  const shares = await deps.shares(fills.map(rowIdOf));
  const names = new Map<string, { leaderRef: string; displayName: string } | null>();
  for (const leaderId of new Set(fills.map((c) => c.leaderId))) names.set(leaderId, await deps.leadName(leaderId));
  return {
    asOf,
    venue: await deps.venueLabel(),
    rows: fills.map((c) => {
      const name = names.get(c.leaderId) ?? null;
      return {
        fillId: c.fill.fillId,
        followId: c.followId,
        symbol: c.fill.symbol,
        side: c.fill.side,
        amount: formatAmount(c.fill.amount),
        price: formatAmount(c.fill.price),
        filledAt: c.fill.filledAt.toISOString(),
        venueFee: { amount: formatAmount(c.fill.venueFee), asset: c.fill.feeAsset },
        builderFee: { amount: formatAmount(c.fill.builderFee), asset: c.fill.feeAsset },
        lead: { leaderRef: name?.leaderRef ?? null, displayName: name?.displayName ?? null },
        feeShare: feeShareState(c, shares.get(rowIdOf(c))),
      };
    }),
  };
}

const ShareRow = z.object({
  fill_id: z.string(),
  leader_id: z.string(),
  asset_id: z.string(),
  capped_leader_share: z.string(),
  applied_share_bps: z.number().int(),
  skipped_reason: z.string().nullable(),
  settled: z.boolean(),
});

/** The SQL read of the stored shares behind a follower's copied fills (svc-trade's own table). */
export function sqlCopyShares(sql: Sql): MyCopyFeesDeps['shares'] {
  return async (rowIds) => {
    const out = new Map<string, StoredCopyShare>();
    if (rowIds.length === 0) return out;
    const rows = ShareRow.array().parse(
      await sql`
        SELECT fill_id, leader_id, asset_id, capped_leader_share::text AS capped_leader_share, applied_share_bps, skipped_reason, settled
          FROM trade.copy_settled_fee_shares WHERE fill_id = ANY(${[...rowIds]}::text[])`,
    );
    for (const r of rows) {
      out.set(r.fill_id, {
        rowId: r.fill_id,
        leaderId: r.leader_id,
        assetId: r.asset_id,
        amount: r.capped_leader_share,
        appliedShareBps: r.applied_share_bps,
        skippedReason: r.skipped_reason === 'cap_reached' || r.skipped_reason === 'zero_share' ? r.skipped_reason : null,
        settled: r.settled,
      });
    }
    return out;
  };
}
