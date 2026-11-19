/**
 * A lead's own desk (J-copy-bots-otc-06 #3 to #5; CB-copy-pro-share-02/03, CB-copy-13 level read).
 *
 * - Earnings: the fee-share rows recorded for this lead (`copy_settled_fee_shares`, settled only), each with its fill,
 *   asset and amount, and their sum per asset. A lead is paid a share of our trading fee only, so the panel carries the
 *   profit-share refusal sentence and no profit, loss, return or "unrealised" figure.
 * - Level: the owner has published no level thresholds, so the level is not set and no level is written; the maximum
 *   ratio is never the platform's to set (`maxRatio: null`).
 * - Setting a profit share or a maximum ratio is refused `trade.copy_pnl_fee_forbidden` before anything is read or
 *   written, for every caller.
 *
 * Read only. Never a ledger post, never a balance.
 */
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { refusePnlLinkedCopyFee } from './fee-share.js';
import type { CopyFeeShareLaw } from './fee-share-law.js';

/** The sentence the earnings panel shows, word for word, wherever a profit share would be. */
export const LEAD_PROFIT_SHARE_REFUSAL = 'Leaders are paid a share of the trading fee only, never a share of profit.';

export const LEAD_EARNINGS_PAGE_MAX = 200;

export type LeadFeeShareRow = {
  readonly fillId: string;
  readonly followId: string;
  readonly assetId: string;
  /** Our fee on the follower's fill the share is taken from. */
  readonly feeOnFill: Amount;
  readonly appliedShareBps: number;
  readonly amount: Amount;
  readonly at: Date;
};

export type ReadLeadFeeShares = (leaderId: string, limit: number) => Promise<LeadFeeShareRow[]>;

type Row = {
  fill_id: string;
  follow_id: string;
  asset_id: string;
  protocol_fee: string;
  applied_share_bps: number;
  capped_leader_share: string;
  created_at: Date;
};

/** The SQL reader: this lead's settled fee-share rows, newest first. */
export function sqlLeadFeeShares(sql: Sql): ReadLeadFeeShares {
  return async (leaderId, limit) => {
    const rows = await sql<Row[]>`
      SELECT fill_id, follow_id, asset_id, protocol_fee::text, applied_share_bps, capped_leader_share::text, created_at
        FROM trade.copy_settled_fee_shares
       WHERE leader_id = ${leaderId} AND settled = true
       ORDER BY created_at DESC, fill_id DESC
       LIMIT ${limit}
    `;
    return rows.map((row) => ({
      fillId: row.fill_id,
      followId: row.follow_id,
      assetId: row.asset_id,
      feeOnFill: parseAmount(row.protocol_fee),
      appliedShareBps: row.applied_share_bps,
      amount: parseAmount(row.capped_leader_share),
      at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    }));
  };
}

/** Pure: the earnings panel's wire form. Totals are per asset; with no rows there are no totals. */
export function presentLeadEarnings(law: CopyFeeShareLaw, rows: readonly LeadFeeShareRow[]) {
  const totals = new Map<string, Amount>();
  for (const row of rows) totals.set(row.assetId, (totals.get(row.assetId) ?? 0n) + row.amount);
  return {
    profitShare: LEAD_PROFIT_SHARE_REFUSAL,
    leaderShareBps: law.published === true ? String(law.leaderShareBps) : null,
    totals: [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([assetId, amount]) => ({ assetId, amount: formatAmount(amount) })),
    items: rows.map((row) => ({
      fillId: row.fillId,
      followId: row.followId,
      assetId: row.assetId,
      feeOnFill: formatAmount(row.feeOnFill),
      appliedShareBps: row.appliedShareBps,
      amount: formatAmount(row.amount),
      at: row.at.toISOString(),
    })),
  };
}

export type LeadEarnings = ReturnType<typeof presentLeadEarnings>;

/**
 * Pure: the level view. The owner has published no thresholds, so the level is not set (a blank threshold never
 * counts as zero) and the maximum ratio is not the platform's.
 */
export function presentLeadLevel(listing: { readonly leaderRef: string; readonly state: string } | null) {
  return {
    leaderRef: listing?.leaderRef ?? null,
    listingState: listing?.state ?? null,
    level: null,
    levelReason: 'thresholds_unset' as const,
    maxRatio: null,
  };
}

export type LeadLevel = ReturnType<typeof presentLeadLevel>;

/** Any profit pre-deduction or profit-share ratio. Refused for every caller, before anything is read or written. */
export function refuseLeadProfitShare(): never {
  return refusePnlLinkedCopyFee();
}

/** Any maximum ratio. A ratio is a share of profit, so it is refused the same way. */
export function refuseLeadMaxRatio(): never {
  return refusePnlLinkedCopyFee();
}
