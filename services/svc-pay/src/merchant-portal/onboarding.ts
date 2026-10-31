import type { Sql } from 'postgres';
import type { MerchantAreaFence } from '../merchant-ownership.js';
import { assertMerchantAreaAccess } from '../merchant-ownership.js';
import { allowMerchantRead } from '../merchant-read-access.js';
import type { MerchantTeamRead } from '../merchant-team-read.js';
import { maskDestination, safeDestinationLabel } from '../control/mask-destination.js';
import type { PayService } from '../payment-service.js';
import { SubMerchantError } from '../submerchants.js';
import { categoryBlockers } from '../onboarding-policy/category.js';
import { ONBOARDING_BLOCKERS, type MerchantBusinessProfile, type MerchantTermsState } from '@intafaced/contracts';

type Blocker = (typeof ONBOARDING_BLOCKERS)[number];

/**
 * Onboarding and go-live progress, derived from rows this service already has.
 *
 * Documents stay `pending_vendor`: no KYB document vendor is configured, and
 * this read does not pretend one is. Terms are `not_configured` while the owner
 * has published no version, so there is nothing to accept (`terms.ts`). Destinations are masked
 * with the same function the payout approval list uses. A PayFac parent sees
 * those masked destinations only when it holds `settlement.payout` over the
 * subject. The owner and an active team member still see them.
 */
export async function readOnboardingProgress(
  sql: Sql,
  pay: Pick<PayService, 'getMerchant' | 'getMerchantByUserId'>,
  trees: MerchantAreaFence | null,
  team: MerchantTeamRead,
  userId: string | undefined,
  profile: MerchantBusinessProfile,
  readTerms: () => Promise<MerchantTermsState>,
) {
  await allowMerchantRead({
    ownerCheck: () => assertMerchantAreaAccess(pay, userId, profile.merchantId, 'merchant.profile', trees),
    team,
    userId,
    merchantId: profile.merchantId,
    permission: 'profile.read',
  });
  const merchant = await pay.getMerchant(profile.merchantId);
  const showDestinations = await payoutDestinationsVisible(pay, trees, team, userId, profile.merchantId, merchant.userId);
  const destinations = await sql<Array<{ rail_id: string; kind: string; ref: string; verified: boolean; activates_at: Date | null }>>`
    SELECT rail_id, kind, ref, verified, activates_at FROM pay.merchant_payout_destinations
     WHERE merchant_id = ${profile.merchantId}
     ORDER BY rail_id`;
  // J-merchant-02 #5: only a destination verified with a step-up counts. A held one (verified, waiting out the hold,
  // stored `verified = false` with `activates_at`) counts: it becomes payable with no further step from the owner. An
  // unverified one does not.
  const verifiedCount = destinations.filter((row) => row.verified || row.activates_at !== null).length;
  const missing: Array<'legalName' | 'displayName' | 'address'> = [];
  if (!profile.legalName) missing.push('legalName');
  if (!profile.displayName) missing.push('displayName');
  if (!profile.address) missing.push('address');
  const blocking: Blocker[] = [];
  if (missing.length > 0) blocking.push('business_incomplete');
  blocking.push('documents_pending_vendor');
  if (verifiedCount === 0) blocking.push('destination_missing');
  const terms = await readTerms();
  if (terms.state === 'not_configured') blocking.push('terms_not_configured');
  else if (terms.state === 'not_accepted') blocking.push('terms_not_accepted');
  if (merchant.kybStatus !== 'approved') blocking.push('kyb_not_approved');
  if (merchant.status !== 'active') blocking.push('merchant_not_active');
  blocking.push(...(await categoryBlockers(sql, profile.merchantId)));
  return {
    merchantId: profile.merchantId,
    business: { done: missing.length === 0, missing },
    documents: { state: 'pending_vendor' as const },
    terms,
    destination: {
      present: verifiedCount > 0,
      destinations: showDestinations
        ? destinations.map((row) => ({
            railId: safeDestinationLabel(row.rail_id, row.ref),
            kind: safeDestinationLabel(row.kind, row.ref),
            destinationMasked: maskDestination(row.kind, row.ref),
          }))
        : [],
    },
    kybStatus: merchant.kybStatus,
    merchantStatus: merchant.status,
    blocking,
  };
}

/**
 * Owner and this merchant's team see masked destinations. A PayFac ancestor
 * sees them only with the `settlement.payout` area. The root of a tree holds
 * every area; an intermediate node does not until that area is granted.
 */
async function payoutDestinationsVisible(
  pay: Pick<PayService, 'getMerchant' | 'getMerchantByUserId'>,
  trees: MerchantAreaFence | null,
  team: MerchantTeamRead,
  userId: string | undefined,
  merchantId: string,
  ownerUserId: string,
): Promise<boolean> {
  if (!userId) return false;
  if (userId === ownerUserId) return true;
  if (await team.activeRole(userId, merchantId)) return true;
  if (!trees) return false;
  const actor = await pay.getMerchantByUserId(userId);
  if (!actor) return false;
  try {
    await trees.assertHolds(actor.id, merchantId, 'settlement.payout');
    return true;
  } catch (err) {
    if (err instanceof SubMerchantError) return false;
    throw err;
  }
}
