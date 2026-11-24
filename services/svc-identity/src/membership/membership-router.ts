import { router } from '@intafaced/contracts/trpc';
import { membershipOffer, type MembershipTier } from './membership-offer.js';
import { IDENTITY_MEMBERSHIP_OFFER } from '@intafaced/contracts/identity-membership-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from '../record-refusal.js';

/** Read-only. There is no purchase door in this slice: buying waits on the owner decision and a ledger recipe. */
export function createMembershipRouter(tiers: readonly MembershipTier[]) {
  return router({
    membership: router({
      offer: mountRecord(IDENTITY_MEMBERSHIP_OFFER, () => membershipOffer(tiers), codedRefusal),
    }),
  });
}
