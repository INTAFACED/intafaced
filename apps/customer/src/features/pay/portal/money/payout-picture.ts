import { useResource } from '../../../../shared/resource';
import type { ApiResult } from '../../../../shared/api';
import type { PortalApi } from '../api';
import { isNotLive } from '../refusal';
import type { Approval } from '../schemas';
import { approvalsBySettlement, tallyPayouts, type PayoutTally } from './model';
import type { PayoutItem } from './schemas';

export const PAYOUT_STATUSES = ['pending', 'posted', 'paid_out', 'failed'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** Everything the payout counts are worked out from, read once so Settlements, Payouts and Balances can never disagree. */
export type PayoutPicture = {
  items: PayoutItem[];
  /** The newest approval request per settlement, or null when the approvals could not be read. */
  approvals: ReadonlyMap<string, Approval> | null;
  /** True per status when the service has more rows than the page read, so a count must say "newest". */
  more: Record<PayoutStatus, boolean>;
  approvalsMore: boolean;
  tally: PayoutTally;
};

/** How many approval requests are read to know each settlement's newest one. */
const APPROVALS_READ = 50;

async function readStatus(portal: PortalApi, merchantId: string, status: PayoutStatus, signal: AbortSignal) {
  const direct = await portal.payoutPage({ status }, undefined, signal, 25);
  if (direct.ok) {
    const page = 'items' in direct.data ? direct.data : { items: direct.data, nextCursor: null };
    return { ok: true as const, data: { items: page.items, more: page.nextCursor !== null } };
  }
  if (!isNotLive(direct)) return direct;
  // The payouts list is not released: a payout is the second half of a settlement, so read the settlements instead.
  const derived = await portal.settlementPage(merchantId, { status }, undefined, signal);
  if (!derived.ok) return derived;
  return {
    ok: true as const,
    data: {
      items: derived.data.items.map((s): PayoutItem => ({
        id: s.id,
        window: s.window,
        assetId: s.assetId,
        gross: s.gross,
        fees: s.fees,
        net: s.net,
        status: s.status,
        payoutMethod: s.payoutMethod,
        payoutReference: s.payoutRef,
        createdAt: s.createdAt ?? new Date(0).toISOString(),
      })),
      more: derived.data.nextCursor !== null,
    },
  };
}

export async function loadPayoutPicture(portal: PortalApi, merchantId: string, signal: AbortSignal): Promise<ApiResult<PayoutPicture>> {
  const [reads, approvalRead] = await Promise.all([
    Promise.all(PAYOUT_STATUSES.map((status) => readStatus(portal, merchantId, status, signal))),
    portal.approvalPage(merchantId, {}, undefined, signal),
  ]);
  const bad = reads.find((r) => !r.ok);
  if (bad && !bad.ok) return bad;
  const more = {} as Record<PayoutStatus, boolean>;
  const items: PayoutItem[] = [];
  reads.forEach((r, i) => {
    if (!r.ok) return;
    more[PAYOUT_STATUSES[i]!] = r.data.more;
    items.push(...r.data.items);
  });
  let approvals: ReadonlyMap<string, Approval> | null = null;
  let approvalsMore = false;
  if (approvalRead.ok) {
    const page = 'items' in approvalRead.data ? approvalRead.data : { items: approvalRead.data, nextCursor: null };
    approvals = approvalsBySettlement(page.items);
    approvalsMore = page.nextCursor !== null;
  }
  return { ok: true, data: { items, approvals, more, approvalsMore, tally: tallyPayouts(items, approvals) } };
}

/** The shared read behind the payout counts and the state shown on every payout row. */
export function usePayoutPicture(portal: PortalApi, merchantId: string) {
  return useResource((signal) => loadPayoutPicture(portal, merchantId, signal), `money:payout-picture:${merchantId}`);
}

/**
 * A count for display: the exact number when everything it depends on was read in full, otherwise "N newest" because
 * older rows were not read. `states` are the payout states the count adds up (ready is built from posted rows and the
 * approvals, so it depends on both).
 */
export function pictureCount(
  picture: Pick<PayoutPicture, 'tally' | 'more' | 'approvalsMore'>,
  state: keyof PayoutTally,
): { n: number; newest: boolean } {
  const status: PayoutStatus =
    state === 'paid_out' ? 'paid_out' : state === 'failed' ? 'failed' : state === 'not_ready' ? 'pending' : 'posted';
  const dependsOnApprovals = status === 'posted';
  return { n: picture.tally[state], newest: picture.more[status] || (dependsOnApprovals && picture.approvalsMore) };
}
