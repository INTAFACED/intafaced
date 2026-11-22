/**
 * The Market's money calls and their outcomes, without their drawing: the purchase with its fresh-terms check, the buyer's
 * refund request, the access cancellation, and the recovery of an action whose outcome was not read back. One logic for
 * the catalogue on the kit (`./MarketRoom.tsx`, /market) and the old view (`../Market.tsx`, /market/mine,
 * /market/strategy, /market/purchases), which share the 'market' action journal.
 */
import {
  MARKET_CANCEL_SUBSCRIPTION,
  MARKET_LISTINGS,
  MARKET_MY_PURCHASES,
  MARKET_PURCHASE,
  MARKET_REFUND,
  MARKET_REQUEST_REFUND,
  type ListingReviewState,
  type MarketListing,
  type MarketPurchase,
} from '@intafaced/contracts/market-procedures';
import type { ApiResult, RefusalReason } from '../../../shared/api';
import type { useApi } from '../../session';
import { presentActionFailure } from '../action-state';
import { copy, t as copyText } from '../copy';

type Api = ReturnType<typeof useApi>;
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

/** The original outcome of a Market action whose answer was not read back, by its journal reference. */
export async function recoverMarketAction(api: Api, userId: string | null | undefined, reference: string): Promise<ApiResult<unknown>> {
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
}

/**
 * Buys `row` under `purchaseId` once its terms still match the catalogue; `onOutcome` hears whether the service held it,
 * so the success line says held when it did.
 */
export async function purchaseListing(
  api: Api,
  {
    userId,
    row,
    purchaseId,
    canDispatch,
    onOutcome,
  }: {
    userId: string | null | undefined;
    row: MarketListing;
    purchaseId: string;
    canDispatch: () => boolean;
    onOutcome: (outcome: 'held' | 'paid') => void;
  },
): Promise<ApiResult<unknown>> {
  const fresh = await api.call(MARKET_LISTINGS, { limit: 50 });
  if (!fresh.ok) return fresh;
  const current = fresh.data.find((r) => r.id === row.id);
  if (
    !current ||
    current.status !== 'active' ||
    current.vendorId !== row.vendorId ||
    current.price !== row.price ||
    current.assetId !== row.assetId ||
    current.periodSeconds !== row.periodSeconds ||
    current.offerType !== row.offerType
  )
    return marketRefusal('error', 'market.the.listing.terms.changed.reload.the.catalogue');
  if (!canDispatch()) return marketRefusal('aborted', 'market.the.account.changed.review.this.purchase.again');
  const result = await api.call(
    MARKET_PURCHASE,
    { listingId: row.id, purchaseId },
    {
      accept: (p) =>
        p.id === purchaseId &&
        p.listingId === row.id &&
        p.buyerId === userId &&
        p.vendorId === row.vendorId &&
        p.assetId === row.assetId &&
        p.price === row.price,
    },
  );
  if (result.ok) {
    onOutcome(result.data.status === 'held' ? 'held' : 'paid');
    return originalPurchaseOutcome(result.data);
  }
  if (result.reason === 'aborted' || result.status === 401 || result.status === 403) return result;
  // The existing pending banner supplies authored recovery guidance.
  // Retain the original service explanation or transport copy descriptor.
  return { ...result, reason: 'uncertain' };
}

/** The buyer asks the seller to refund a held purchase. */
export async function requestMarketRefund(api: Api, userId: string | null | undefined, row: MarketPurchase) {
  return refundPolicyUnset(
    await api.call(
      MARKET_REQUEST_REFUND,
      { purchaseId: row.id },
      { accept: (p) => p.id === row.id && p.buyerId === userId && p.status === 'held' && Boolean(p.refundRequestedAt) },
    ),
  );
}

/** The seller refunds a held purchase whose buyer asked. */
export async function refundMarketPurchase(api: Api, row: MarketPurchase) {
  return refundPolicyUnset(
    await api.call(
      MARKET_REFUND,
      { purchaseId: row.id },
      { accept: (p) => p.id === row.id && p.buyerId === row.buyerId && p.status === 'refunded' },
    ),
  );
}

/** The buyer ends access to a subscription listing; no refund is issued. */
export function cancelMarketSubscription(api: Api, userId: string | null | undefined, row: MarketPurchase) {
  return api.call(
    MARKET_CANCEL_SUBSCRIPTION,
    { listingId: row.listingId },
    { accept: (result) => result.listingId === row.listingId && result.buyerId === userId },
  );
}
