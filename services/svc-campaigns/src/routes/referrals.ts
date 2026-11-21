import { router, scopedProcedure } from '@intafaced/contracts';
import { myInviteesInputSchema, myInviteesSchema } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from '../codes.js';
import { guard, mapError } from './kit.js';
import type { CampaignServices } from '../router.js';

/** Referral programmes (CM-referral-02): the caller's own invitees. */
export function referralRoutes({ referrals }: CampaignServices) {
  return {
    customer: {
      referral: router({
        /**
         * The caller's own invitees (CM-referral-02): each one's place, when they joined, each step done or not and their
         * state, never who they are. The account is the signed principal's.
         */
        invitees: scopedProcedure('campaigns:read', guard)
          .input(myInviteesInputSchema)
          .output(myInviteesSchema)
          .query(async ({ ctx }) => {
            try {
              if (!referrals) throw new CampaignsError('campaigns.store_unwired', 'Referral progress is not wired');
              return await referrals.myInvitees({ referrerId: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
  };
}
