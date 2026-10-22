import { anyScopeProcedure } from '@intafaced/contracts';

/**
 * A merchant's reads of its own account, for the portal (J-merchant-01, M-adv-phantom-order-02).
 *
 * The owner grant law gives `pay:read` only once KYB is approved, so an owner who has just opened a
 * business holds `pay:onboard` alone. Stripe-style, that owner still sees every room of the account
 * in its restricted state rather than "no access". So these reads take either scope. Nothing here
 * widens what a caller may see: every procedure built on it still resolves the caller's own merchant,
 * or checks the caller's membership of the merchant it names, before it reads a row. Writes, refunds
 * and payouts keep their own scopes and the KYB money gate.
 */
export function ownMerchantRead() {
  return anyScopeProcedure(['pay:onboard', 'pay:read'], { module: 'pay' });
}
