import type { Sql } from 'postgres';
import type { MerchantAreaFence } from '../merchant-ownership.js';
import { assertMerchantAreaAccess } from '../merchant-ownership.js';
import { allowMerchantRead } from '../merchant-read-access.js';
import type { MerchantTeamRead } from '../merchant-team-read.js';
import { maskDestination, safeDestinationLabel } from '../control/mask-destination.js';
import type { PayService } from '../payment-service.js';
import { ONBOARDING_BLOCKERS, type MerchantBusinessProfile } from '@intafaced/contracts';

type Blocker = (typeof ONBOARDING_BLOCKERS)[number];

/**
 * Onboarding and go-live progress, derived from rows this service already has.
 *
 * Documents stay `pending_vendor`: no KYB document vendor is configured, and
 * this read does not pretend one is. Terms stay `not_configured`: no terms
 * version is published, so there is nothing to accept. Destinations are masked
 * with the same function the payout approval list uses.
 */
export async function readOnboardingProgress(
  sql: Sql,
  pay: Pick<PayService, 'getMerchant' | 'getMerchantByUserId'>,
  trees: MerchantAreaFence | null,
  team: MerchantTeamRead,
  userId: string | undefined,
  profile: MerchantBusinessProfile,
) {
  await allowMerchantRead({
    ownerCheck: () => assertMerchantAreaAccess(pay, userId, profile.merchantId, 'merchant.profile', trees),
    team,
    userId,
    merchantId: profile.merchantId,
    permission: 'profile.read',
  });
  const merchant = await pay.getMerchant(profile.merchantId);
  const destinations = await sql<Array<{ rail_id: string; kind: string; ref: string }>>`
    SELECT rail_id, kind, ref FROM pay.merchant_payout_destinations
     WHERE merchant_id = ${profile.merchantId}
     ORDER BY rail_id`;
  const missing: Array<'legalName' | 'displayName' | 'address'> = [];
  if (!profile.legalName) missing.push('legalName');
  if (!profile.displayName) missing.push('displayName');
  if (!profile.address) missing.push('address');
  const blocking: Blocker[] = [];
  if (missing.length > 0) blocking.push('business_incomplete');
  blocking.push('documents_pending_vendor');
  if (destinations.length === 0) blocking.push('destination_missing');
  blocking.push('terms_not_configured');
  if (merchant.kybStatus !== 'approved') blocking.push('kyb_not_approved');
  if (merchant.status !== 'active') blocking.push('merchant_not_active');
  return {
    merchantId: profile.merchantId,
    business: { done: missing.length === 0, missing },
    documents: { state: 'pending_vendor' as const },
    terms: { state: 'not_configured' as const },
    destination: {
      present: destinations.length > 0,
      destinations: destinations.map((row) => ({
        railId: safeDestinationLabel(row.rail_id, row.ref),
        kind: safeDestinationLabel(row.kind, row.ref),
        destinationMasked: maskDestination(row.kind, row.ref),
      })),
    },
    kybStatus: merchant.kybStatus,
    merchantStatus: merchant.status,
    blocking,
  };
}
