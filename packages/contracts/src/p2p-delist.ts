/**
 * Why an operator retired a P2P payment method (P-trade-orders-03). svc-p2p stores one of these with the retirement
 * (and its migration's CHECK constraint holds the same list), the error shape carries it on `p2p.method_delisted`, and
 * the customer app words each one. Browser-safe: no server imports.
 */
export const P2P_DELIST_REASONS = ['regulation', 'provider_withdrawn', 'fraud_risk', 'low_demand'] as const;
export type P2pDelistReason = (typeof P2P_DELIST_REASONS)[number];
