/**
 * Payout status is this function of the timeline, in time order.
 *
 * A rejected approval does not keep a later confirmation failed. A confirmation
 * does not survive a later reversal. `rail.sent` is not confirmation: send
 * without a confirm stays at the settlement's posted state.
 *
 * This function sees kinds only. `readPayoutLifecycle` appends one synthetic
 * kind when the settlement status column is ahead of the recorded timestamps,
 * so the derived status is never lower than that column.
 */

export const LIFECYCLE_KINDS = [
  'settlement.opened',
  'settlement.posted',
  'settlement.released',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.voided',
  'approval.expired',
  'approval.consumed',
  'payout.admitted',
  'rail.sent',
  'rail.confirmed',
  'rail.refused',
  'payout.reversed',
] as const;

export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];
export type LifecycleStatus = 'pending' | 'posted' | 'paid_out' | 'failed';

const RANK: Record<LifecycleKind, number> = {
  'settlement.opened': 0,
  'approval.requested': 1,
  'approval.approved': 2,
  'approval.rejected': 2,
  'approval.voided': 2,
  'approval.expired': 2,
  'approval.consumed': 2,
  'settlement.posted': 3,
  'payout.admitted': 4,
  'rail.sent': 5,
  'rail.confirmed': 6,
  'rail.refused': 7,
  'payout.reversed': 8,
  'settlement.released': 9,
};

export function compareLifecycleEvents(
  a: { at: string | null; kind: LifecycleKind; id: string },
  b: { at: string | null; kind: LifecycleKind; id: string },
): number {
  if (a.at === null || b.at === null) {
    if (a.at !== b.at) return a.at === null ? 1 : -1;
  } else if (a.at !== b.at) {
    return a.at < b.at ? -1 : 1;
  }
  const rank = RANK[a.kind] - RANK[b.kind];
  if (rank !== 0) return rank;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function derivePayoutLifecycleStatus(kinds: readonly LifecycleKind[]): LifecycleStatus {
  let status: LifecycleStatus = 'pending';
  for (const kind of kinds) {
    if (kind === 'settlement.posted' && status === 'pending') status = 'posted';
    if (kind === 'rail.confirmed') status = 'paid_out';
    if (kind === 'settlement.released' || kind === 'rail.refused' || kind === 'payout.reversed') status = 'failed';
  }
  return status;
}
