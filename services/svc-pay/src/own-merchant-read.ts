import { anyScopeProcedure } from '@intafaced/contracts';

/**
 * A merchant's reads of its own account, for the portal (J-merchant-01, M-adv-phantom-order-02).
 *
 * The owner grant law gives `pay:read` only once KYB is approved, so an owner who has just opened a
 * business holds `pay:onboard` alone. Stripe-style, that owner still sees every room of the account
 * in its restricted state rather than "no access". So these reads take either scope, and both are
 * rechecked against the live merchant (a suspended or closed business loses them at once). Every
 * procedure built on this resolves the caller's own merchant, or checks the caller's membership of
 * the merchant it names, before it reads a row. The two platform-wide reads on it say so where they
 * are defined: `railHealth` needs a business of the caller's own, and `payHalts.status` without a
 * merchant id still needs `pay:read`. Writes, refunds and payouts keep their own scopes and the KYB
 * money gate.
 */
export function ownMerchantRead() {
  return anyScopeProcedure(['pay:onboard', 'pay:read'], { module: 'pay' });
}
