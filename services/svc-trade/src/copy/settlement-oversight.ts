import { formatAmount, parseAmount, type Amount, type LedgerClient, type LedgerTx } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { CopyError } from './errors.js';
import { copyFeeShareLedgerKeys } from './fee-share.js';

/**
 * COPY SETTLEMENT OVERSIGHT (CB-ops-02, J-copy-bots-otc-11 #1 #2 #3 #4). Read only: finance's view of every lead fee share
 * owed, each matched three ways, fill by fill:
 *
 * - the share as `copy_settled_fee_shares` stores it (what we owe the lead on one copied fill, and the fee it is a share of);
 * - the ledger's own transactions under the share's two keys (`copyFeeShareLedgerKeys`: the sweep of house fees into the
 *   rewards pot and the payout to the lead), each carrying the stored amount;
 * - the builder fee the venue reported for the follower's fill of that copy (`trade.venue_builder_fees`, as the builder-fee
 *   poster recorded the venue's own report), equal to the fee the share is of.
 *
 * "Settled" only when all three agree. Anything missing or different is "Held" with the payout key and every reason, a row
 * for a person: nothing here posts, and a held row is never posted to make the figures agree (launch money model 6).
 * A copy filled on the TEST book has no venue fill, so no venue reports a builder fee for it, and it is held for that.
 *
 * A share the cap or a zero fee left at nothing is not owed, and is counted apart, never as settled.
 */

/** The reconcile windows finance chooses from. There is no default: a blank window refuses. */
export const SETTLEMENT_WINDOWS = { '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000, '30d': 30 * 24 * 3_600_000 } as const;
export type SettlementWindow = keyof typeof SETTLEMENT_WINDOWS;

/** The newest shares the oversight lists at once. */
export const SETTLEMENT_LIST_LIMIT = 200;

export type SettlementHeldReason =
  'settle_unfinished' | 'ledger_post_missing' | 'ledger_amount_differs' | 'venue_not_reported' | 'venue_fee_differs';

/** The words a held row shows for each reason. */
export const HELD_REASON_TEXT: Record<SettlementHeldReason, string> = {
  settle_unfinished: 'The settle started and did not finish, so nothing is owed on it.',
  ledger_post_missing: 'The ledger has no post under the key.',
  ledger_amount_differs: 'The ledger post is a different amount from the share.',
  venue_not_reported: 'The venue reports no builder fee for this fill.',
  venue_fee_differs: 'The venue reports a different builder fee from the fee the share is of.',
};

export interface StoredShareRow {
  readonly followId: string;
  readonly fillId: string;
  readonly leaderId: string;
  readonly followerId: string;
  readonly assetId: string;
  /** The fee the share is of: the follower fill's collected fee. */
  readonly protocolFee: Amount;
  /** What we owe the lead on this fill. */
  readonly owed: Amount;
  readonly skippedReason: null | 'cap_reached' | 'zero_share';
  readonly settled: boolean;
  readonly createdAt: Date;
}

/** One builder fee the venue reported on the follower's fill of a copy. */
export interface VenueBuilderFeeReport {
  readonly venueId: string;
  readonly fillId: string;
  readonly assetId: string;
  readonly amount: Amount;
  readonly recordedAt: Date;
}

export interface SettlementRow {
  readonly followId: string;
  readonly fillId: string;
  readonly leaderId: string;
  readonly followerId: string;
  readonly assetId: string;
  readonly feeOfFill: string;
  readonly owed: string;
  readonly status: 'settled' | 'held' | 'not_owed';
  /** The payout's ledger key; the key a held row is resolved under. */
  readonly key: string;
  readonly sweepKey: string;
  readonly ledgerAmount: string | null;
  readonly venueAmount: string | null;
  readonly venueId: string | null;
  readonly reasons: readonly SettlementHeldReason[];
  readonly notOwedReason: null | 'cap_reached' | 'zero_share';
  readonly createdAt: string;
}

/** What one transaction moves into the account it debits: the amount the recipe carried. */
function postedAmount(tx: LedgerTx, assetId: string): Amount | null {
  const debits = tx.entries.filter((e) => e.direction === 'debit' && e.assetId === assetId);
  if (debits.length !== 1) return null;
  return debits[0]!.amount;
}

/** Judge one stored share against its two ledger transactions and the venue's reports for its fill. Pure. */
export function judgeSettlement(
  share: StoredShareRow,
  ledger: { readonly sweep: LedgerTx | null; readonly payout: LedgerTx | null },
  venue: readonly VenueBuilderFeeReport[],
): SettlementRow {
  const keys = copyFeeShareLedgerKeys(share.fillId, share.leaderId, share.assetId);
  const base = {
    followId: share.followId,
    fillId: share.fillId,
    leaderId: share.leaderId,
    followerId: share.followerId,
    assetId: share.assetId,
    feeOfFill: formatAmount(share.protocolFee),
    owed: formatAmount(share.owed),
    key: keys.payout,
    sweepKey: keys.sweep,
    createdAt: share.createdAt.toISOString(),
  };
  const payoutAmount = ledger.payout ? postedAmount(ledger.payout, share.assetId) : null;
  const sweepAmount = ledger.sweep ? postedAmount(ledger.sweep, share.assetId) : null;
  const venueSum = venue.filter((v) => v.assetId === share.assetId).reduce((sum, v) => sum + v.amount, 0n);
  const venueReported = venue.length > 0;
  const view = {
    ledgerAmount: payoutAmount === null ? null : formatAmount(payoutAmount),
    venueAmount: venueReported ? formatAmount(venueSum) : null,
    venueId: venue[0]?.venueId ?? null,
  };

  if (share.skippedReason !== null) {
    // Nothing owed. A post under the key all the same is a break, held.
    if (ledger.payout === null && ledger.sweep === null) {
      return { ...base, ...view, status: 'not_owed', reasons: [], notOwedReason: share.skippedReason };
    }
    return { ...base, ...view, status: 'held', reasons: ['ledger_amount_differs'], notOwedReason: share.skippedReason };
  }

  const reasons: SettlementHeldReason[] = [];
  if (!share.settled) reasons.push('settle_unfinished');
  if (ledger.payout === null || ledger.sweep === null) reasons.push('ledger_post_missing');
  else if (payoutAmount !== share.owed || sweepAmount !== share.owed) reasons.push('ledger_amount_differs');
  if (!venueReported) reasons.push('venue_not_reported');
  else if (venue.some((v) => v.assetId !== share.assetId) || venueSum !== share.protocolFee) reasons.push('venue_fee_differs');

  return { ...base, ...view, status: reasons.length === 0 ? 'settled' : 'held', reasons, notOwedReason: null };
}

export interface SettlementCounts {
  readonly compared: number;
  readonly settled: number;
  readonly held: number;
  readonly notOwed: number;
  readonly byReason: Readonly<Record<SettlementHeldReason, number>>;
}

export function countSettlements(rows: readonly SettlementRow[]): SettlementCounts {
  const byReason: Record<SettlementHeldReason, number> = {
    settle_unfinished: 0,
    ledger_post_missing: 0,
    ledger_amount_differs: 0,
    venue_not_reported: 0,
    venue_fee_differs: 0,
  };
  let settled = 0;
  let held = 0;
  let notOwed = 0;
  for (const row of rows) {
    if (row.status === 'settled') settled += 1;
    else if (row.status === 'held') held += 1;
    else notOwed += 1;
    for (const reason of row.reasons) byReason[reason] += 1;
  }
  return { compared: rows.length, settled, held, notOwed, byReason };
}

/** A blank or unknown window refuses; finance chooses one. */
export function requireSettlementWindow(window: string | null | undefined): SettlementWindow {
  const w = (window ?? '').trim();
  if (!w) throw new CopyError('Choose a window to reconcile.', 'trade.copy_settlement_window_required');
  if (!(w in SETTLEMENT_WINDOWS)) throw new CopyError('That reconcile window is not offered.', 'trade.copy_settlement_window_required');
  return w as SettlementWindow;
}

/** Where the oversight reads from. Each is a read; none writes. */
export interface SettlementOversightDeps {
  readonly shares: (q: { since: Date | null; through: Date; followId?: string; limit: number }) => Promise<StoredShareRow[]>;
  readonly venueReports: (shares: readonly StoredShareRow[]) => Promise<Map<string, VenueBuilderFeeReport[]>>;
  readonly ledger: Pick<LedgerClient, 'getTxByKey'>;
}

const shareId = (s: { followId: string; fillId: string }) => `${s.followId}\u0000${s.fillId}`;

/** Ledger reads at once, so a long list stays bounded. */
const LEDGER_READS_AT_ONCE = 16;

async function judgeAll(deps: SettlementOversightDeps, shares: readonly StoredShareRow[]): Promise<SettlementRow[]> {
  const venue = await deps.venueReports(shares);
  const rows: SettlementRow[] = [];
  for (let i = 0; i < shares.length; i += LEDGER_READS_AT_ONCE) {
    const batch = shares.slice(i, i + LEDGER_READS_AT_ONCE);
    const read = await Promise.all(
      batch.map(async (share) => {
        const keys = copyFeeShareLedgerKeys(share.fillId, share.leaderId, share.assetId);
        const [sweep, payout] = await Promise.all([deps.ledger.getTxByKey(keys.sweep), deps.ledger.getTxByKey(keys.payout)]);
        return judgeSettlement(share, { sweep, payout }, venue.get(shareId(share)) ?? []);
      }),
    );
    rows.push(...read);
  }
  return rows;
}

/** The newest lead fee shares, judged (#1). Optionally one follow's (#4). */
export async function listSettlements(deps: SettlementOversightDeps, now: Date, followId?: string) {
  const shares = await deps.shares({ since: null, through: now, followId, limit: SETTLEMENT_LIST_LIMIT });
  const rows = await judgeAll(deps, shares);
  return { asOf: now.toISOString(), rows, counts: countSettlements(rows) };
}

/**
 * Reconcile one window (#2 #3): every share created in it, judged, and the counts. It says what it compared and through
 * what time; nothing compared reads "nothing to compare", never matched.
 */
export async function reconcileSettlements(deps: SettlementOversightDeps, now: Date, window: string | null | undefined) {
  const w = requireSettlementWindow(window);
  const since = new Date(now.getTime() - SETTLEMENT_WINDOWS[w]);
  const shares = await deps.shares({ since, through: now, limit: Number.MAX_SAFE_INTEGER });
  const rows = await judgeAll(deps, shares);
  const counts = countSettlements(rows);
  return {
    window: w,
    from: since.toISOString(),
    through: now.toISOString(),
    verdict: counts.compared === 0 ? ('nothing_to_compare' as const) : counts.held === 0 ? ('matched' as const) : ('held' as const),
    counts,
  };
}

type ShareSqlRow = {
  follow_id: string;
  fill_id: string;
  leader_id: string;
  follower_id: string;
  asset_id: string;
  protocol_fee: string;
  capped_leader_share: string;
  skipped_reason: string | null;
  settled: boolean;
  created_at: Date;
};

/** The SQL reads behind the oversight: svc-trade's own copy tables and the builder-fee log, never another service's. */
export function sqlSettlementOversight(sql: Sql, ledger: Pick<LedgerClient, 'getTxByKey'>): SettlementOversightDeps {
  return {
    ledger,
    async shares({ since, through, followId, limit }) {
      const rows = await sql<ShareSqlRow[]>`
        SELECT follow_id, fill_id, leader_id, follower_id, asset_id, protocol_fee::text, capped_leader_share::text,
               skipped_reason, settled, created_at
          FROM trade.copy_settled_fee_shares
         WHERE created_at <= ${through}
           ${since ? sql`AND created_at > ${since}` : sql``}
           ${followId ? sql`AND follow_id = ${followId}` : sql``}
         ORDER BY created_at DESC, fill_id DESC
         LIMIT ${Math.min(limit, 100_000)}
      `;
      return rows.map((r) => ({
        followId: r.follow_id,
        fillId: r.fill_id,
        leaderId: r.leader_id,
        followerId: r.follower_id,
        assetId: r.asset_id,
        protocolFee: parseAmount(r.protocol_fee),
        owed: parseAmount(r.capped_leader_share),
        skippedReason: r.skipped_reason === 'cap_reached' || r.skipped_reason === 'zero_share' ? r.skipped_reason : null,
        settled: r.settled,
        createdAt: r.created_at,
      }));
    },
    async venueReports(shares) {
      const out = new Map<string, VenueBuilderFeeReport[]>();
      if (shares.length === 0) return out;
      const follows = [...new Set(shares.map((s) => s.followId))];
      // The follower's fills of each copy (the placed mirror's order), and any builder fee a venue reported on them.
      const rows = await sql<
        {
          follow_id: string;
          leader_fill_id: string;
          venue_id: string;
          fill_id: string;
          asset_id: string;
          amount: string;
          recorded_at: Date;
        }[]
      >`
        SELECT p.follow_id, p.fill_id AS leader_fill_id, v.venue_id, v.fill_id, v.asset_id, v.amount, v.recorded_at
          FROM trade.copy_placed_mirrors p
          JOIN trade.fills f ON f.order_id::text = p.order_id
          JOIN trade.venue_builder_fees v ON v.fill_id = f.id::text AND v.status <> 'not_our_order'
         WHERE p.follow_id = ANY(${follows}::text[])
      `;
      for (const r of rows) {
        const id = shareId({ followId: r.follow_id, fillId: r.leader_fill_id });
        const list = out.get(id) ?? [];
        list.push({
          venueId: r.venue_id,
          fillId: r.fill_id,
          assetId: r.asset_id,
          amount: parseAmount(r.amount),
          recordedAt: r.recorded_at,
        });
        out.set(id, list);
      }
      return out;
    },
  };
}
