/**
 * Highest merchant fee rate svc-pay accepts, in basis points.
 *
 * 10000 bps is a 100% fee: every settlement window then nets to zero and refuses with
 * `pay.fee_exceeds_gross`, so the merchant's money would sit in clearing forever. A rate
 * the settlement cannot use is refused where it is set. svc-p2p's bound is 9999 for the
 * same reason (a release must leave the buyer something).
 */
export const MAX_FEE_BPS = 9_999;
