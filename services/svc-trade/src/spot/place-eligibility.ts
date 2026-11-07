/**
 * Who may place a custodial trade order: the one check, shared by every door that places one for a person.
 *
 * - A verification tier below `basic` refuses `tier.insufficient` (AuthError).
 * - The jurisdiction matrix (`checkAccess`, module trade, fiat plane) refuses by its own code (JurisdictionError).
 *
 * The signed-in order door (`placeAttributedOrder` in router.ts) calls it with the request's principal and region. A
 * chart alert webhook (signals/signal-desk.ts) calls it on every alert, with the person's live tier read from identity
 * and the region recorded at create, never the tier its stored grant carries; its create is gated by its procedure's
 * own module check. One function, so the doors cannot drift apart (OWNER 88).
 */
import { AuthError, TIER_ORDER, type Principal } from '@intafaced/auth';
import { checkAccess } from '@intafaced/config';
import { JurisdictionError } from '@intafaced/contracts';

export function assertPlaceEligible(input: { readonly tier: Principal['tier']; readonly region: string }): void {
  if (TIER_ORDER[input.tier] < TIER_ORDER.basic) {
    throw new AuthError('Verification tier "basic" is required', 'tier.insufficient');
  }
  const decision = checkAccess({ module: 'trade', plane: 'fiat', region: input.region, kycTier: input.tier });
  if (!decision.allowed) throw new JurisdictionError(decision);
}
