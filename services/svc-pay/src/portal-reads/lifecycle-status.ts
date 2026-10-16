/**
 * Payout status is this function of the timeline, in time order.
 *
 * A rejected approval does not keep a later confirmation failed. A confirmation
 * does not survive a later reversal. `rail.sent` is not confirmation: send
 * without a confirm stays at the settlement's posted state. The settlement
 * status column is not an input, so the two cannot disagree inside this read.
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
  a: { at: string; kind: LifecycleKind; id: string },
  b: { at: string; kind: LifecycleKind; id: string },
): number {
  const time = a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
  if (time !== 0) return time;
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
