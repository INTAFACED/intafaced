import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { MEMBERSHIP_NOT_OFFERED, membershipOffer, type MembershipTier } from './membership-offer.js';

const tierOut = z
  .object({
    id: z.string(),
    name: z.string(),
    price: z.string(),
    assetId: z.string(),
    periodDays: z.number().int(),
    perks: z.array(z.string()),
  })
  .strict();

const offerOut = z.union([
  z.object({ offered: z.literal(false), code: z.literal(MEMBERSHIP_NOT_OFFERED) }).strict(),
  z.object({ offered: z.literal(true), tiers: z.array(tierOut), current: z.null() }).strict(),
]);

/** Read-only. There is no purchase door in this slice: buying waits on the owner decision and a ledger recipe. */
export function createMembershipRouter(tiers: readonly MembershipTier[]) {
  return router({
    membership: router({
      offer: scopedProcedure('identity:read')
        .output(offerOut)
        .query(() => membershipOffer(tiers)),
    }),
  });
}
