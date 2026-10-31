/**
 * P-trade-orders-19: why an order was cancelled, from a fixed list per side.
 *
 * The buyer's list names what went wrong on the seller's side or their own; the seller's list names what went wrong on
 * the buyer's side or their own. The stored resolution reason is `<actor>.<code>`, so the buyer-cancel count
 * (`BUYER_CANCEL_REASON_PREFIX`) and the order's display status read it unchanged.
 */
export const BUYER_CANCEL_REASONS = [
  'changed_mind',
  'cannot_pay_with_method',
  'seller_payment_details_wrong',
  'seller_unresponsive',
  'seller_extra_terms',
] as const;
export const SELLER_CANCEL_REASONS = [
  'buyer_unresponsive',
  'buyer_name_mismatch',
  'buyer_extra_terms',
  'price_mistake',
  'changed_mind',
] as const;
export const CANCEL_REASON_CODES = [...new Set([...BUYER_CANCEL_REASONS, ...SELLER_CANCEL_REASONS])] as [string, ...string[]];

export type BuyerCancelReason = (typeof BUYER_CANCEL_REASONS)[number];
export type SellerCancelReason = (typeof SELLER_CANCEL_REASONS)[number];
export type CancelReasonCode = BuyerCancelReason | SellerCancelReason;

export function cancelReasonAllowed(actor: 'buyer' | 'seller', code: string): boolean {
  return (actor === 'buyer' ? (BUYER_CANCEL_REASONS as readonly string[]) : (SELLER_CANCEL_REASONS as readonly string[])).includes(code);
}

/**
 * Who cancelled a cancelled order and, when they chose one, the reason code. Null for any other order. A cancel through
 * the API with free text, or before reasons existed, has no code.
 */
export function cancelReasonOf(trade: {
  status: string;
  resolutionReason: string | null;
}): { by: 'buyer' | 'seller' | 'timeout' | 'moderator'; code: CancelReasonCode | null } | null {
  if (trade.status !== 'cancelled') return null;
  const reason = trade.resolutionReason ?? '';
  if (reason.startsWith('moderator:')) return { by: 'moderator', code: null };
  if (reason.startsWith('timeout.')) return { by: 'timeout', code: null };
  const [actor, ...rest] = reason.split('.');
  if (actor !== 'buyer' && actor !== 'seller') return null;
  const code = rest.join('.');
  return { by: actor, code: cancelReasonAllowed(actor, code) ? (code as CancelReasonCode) : null };
}
