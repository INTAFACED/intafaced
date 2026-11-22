import { copy, t as copyText } from './copy';
import { MARKET_MY_PURCHASES, MARKET_REFUND, type ListingReviewState, type MarketPurchase } from '@intafaced/contracts/market-procedures';
import type { useApi } from '../session';
import { presentActionFailure } from './common';
import type { ApiResult, RefusalReason } from '../../shared/api';

/**
 * The Market room's own outcome rules, shared by every Market page (`/market`, `/market/mine`, `/market/purchases`) and
 * the Volt strategy room (`/market/strategy`), so the action journal reads one set of rules whichever page recovers it.
 */
type MarketFailureKey =
  | 'market.original.purchase.is.still.pending.settlement.is'
  | 'market.the.original.settlement.evidence.is.incomplete.keep'
  | 'market.the.original.purchase.is.not.present.in'
  | 'market.the.listing.terms.changed.reload.the.catalogue'
  | 'market.the.account.changed.review.this.purchase.again';
export function marketRefusal(reason: RefusalReason, key: MarketFailureKey) {
  return presentActionFailure({ ok: false as const, reason, message: copyText(key) }, (locale) => {
    const current = copy.forLocale(locale);
    return { message: current.t(key), language: current.languageFor(key) };
  });
}
export const REVIEW_COPY = {
  in_review: 'market.review.state.in.review',
  approved: 'market.review.state.approved',
  rejected: 'market.review.state.rejected',
  suspended: 'market.review.state.suspended',
  taken_down: 'market.review.state.taken.down',
} as const satisfies Record<ListingReviewState, string>;
export function originalPurchaseOutcome(row: MarketPurchase): ApiResult<MarketPurchase> {
  if (row.status === 'pending') return marketRefusal('uncertain', 'market.original.purchase.is.still.pending.settlement.is');
  if (row.status === 'settled' && row.ledgerTxId && row.settledAt) return { ok: true, data: row };
  // A held purchase is paid into the buyer's held pot (MC-market-02); its release or refund comes later.
  if ((row.status === 'held' || row.status === 'released' || row.status === 'refunded') && row.ledgerTxId) return { ok: true, data: row };
  // The service marks rejected only for a definitive failed ledger admission;
  // it retains the rejection code and has no settlement evidence for that row.
  if (row.status === 'rejected' && row.rejectionCode && row.ledgerTxId === null && row.settledAt === null) return { ok: true, data: row };
  return marketRefusal('uncertain', 'market.the.original.settlement.evidence.is.incomplete.keep');
}
/** The service's typed refusal while the refund policy is blank, shown in the room's own words; nothing moved. */
export const refundPolicyUnset = <T>(result: ApiResult<T>): ApiResult<T> =>
  !result.ok && result.code === 'owner.decision'
    ? presentActionFailure(result, (locale) => {
        const current = copy.forLocale(locale);
        return { message: current.t('market.refund.policy.is.not.set'), language: current.languageFor('market.refund.policy.is.not.set') };
      })
    : result;
/** How a Market action whose answer was lost is read back from the service: the `recover` of the room's `useAction('market')`. */
export function marketRecover(api: ReturnType<typeof useApi>, userId: string | null | undefined) {
  return async (reference: string): Promise<ApiResult<unknown>> => {
    // A refund: the service's refund is keyed on the purchase, so asking again returns the stored outcome
    // (the whole price returns once); a purchase that is no longer held is a known outcome, not a pending one. So is
    // owner.decision: the service refuses it only before any refund was claimed, so nothing moved.
    if (reference.startsWith('refund:')) {
      const id = reference.slice('refund:'.length);
      const again = await api.call(MARKET_REFUND, { purchaseId: id }, { accept: (p) => p.id === id && p.status === 'refunded' });
      return !again.ok && (again.code === 'market.refund_not_held' || again.code === 'owner.decision') ? { ok: true, data: null } : again;
    }
    const requested = reference.startsWith('refund-request:') ? reference.slice('refund-request:'.length) : null;
    const rows = await api.call(MARKET_MY_PURCHASES, { limit: 50 }, { accept: (rows) => rows.every((r) => r.buyerId === userId) });
    if (!rows.ok) return rows;
    if (requested) {
      const held = rows.data.find((r) => r.id === requested);
      if (!held) return marketRefusal('uncertain', 'market.the.original.purchase.is.not.present.in');
      if (held.refundRequestedAt || held.status !== 'held') return { ok: true, data: held };
      // The request never landed: it is still the buyer's to send, so the original is known to have failed.
      return { ok: true, data: null };
    }
    const row = rows.data.find((r) => r.id === reference);
    return row ? originalPurchaseOutcome(row) : marketRefusal('uncertain', 'market.the.original.purchase.is.not.present.in');
  };
}
