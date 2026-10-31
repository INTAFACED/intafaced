/**
 * Why a P2P order was cancelled before payment (P-trade-orders-19). Each side picks from its own list; svc-p2p refuses a
 * code from the other side's list (`p2p.cancel_reason_invalid`), stores the choice with the cancel, and returns it on
 * `trades.get` as `cancelReason`; the customer app words each one. Browser-safe: no server imports.
 */
export const P2P_BUYER_CANCEL_REASONS = [
  'changed_mind',
  'cannot_pay_with_method',
  'seller_payment_details_wrong',
  'seller_unresponsive',
  'seller_extra_terms',
] as const;
export const P2P_SELLER_CANCEL_REASONS = [
  'buyer_unresponsive',
  'buyer_name_mismatch',
  'buyer_extra_terms',
  'price_mistake',
  'changed_mind',
] as const;
/** Every code either side may give, once each. */
export const P2P_CANCEL_REASONS = [...new Set([...P2P_BUYER_CANCEL_REASONS, ...P2P_SELLER_CANCEL_REASONS])] as [
  P2pCancelReason,
  ...P2pCancelReason[],
];
export type P2pCancelReason = (typeof P2P_BUYER_CANCEL_REASONS)[number] | (typeof P2P_SELLER_CANCEL_REASONS)[number];
/** Who ended a cancelled order. */
export const P2P_CANCELLED_BY = ['buyer', 'seller', 'timeout', 'moderator'] as const;
export type P2pCancelledBy = (typeof P2P_CANCELLED_BY)[number];

export function p2pCancelReasonAllowed(side: 'buyer' | 'seller', code: string): code is P2pCancelReason {
  return (side === 'buyer' ? (P2P_BUYER_CANCEL_REASONS as readonly string[]) : (P2P_SELLER_CANCEL_REASONS as readonly string[])).includes(
    code,
  );
}
