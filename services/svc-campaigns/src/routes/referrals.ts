import { router } from '@intafaced/contracts';
import { CampaignsError } from '../codes.js';
import { mapError, refusalOf } from './kit.js';
import type { CampaignServices } from '../router.js';
import { CAMPAIGNS_REFERRAL_INVITEES } from '@intafaced/contracts/campaigns-referral-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';

/** Referral programmes (CM-referral-02): the caller's own invitees. */
export function referralRoutes({ referrals }: CampaignServices) {
  return {
    customer: {
      referral: router({
        /**
         * The caller's own invitees (CM-referral-02): each one's place, when they joined, each step done or not and their
         * state, never who they are. The account is the signed principal's.
         */
        invitees: mountRecord(
          CAMPAIGNS_REFERRAL_INVITEES,
          async ({ ctx }) => {
            try {
              if (!referrals) throw new CampaignsError('campaigns.store_unwired', 'Referral progress is not wired');
              return await referrals.myInvitees({ referrerId: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          },
          refusalOf,
        ),
      }),
    },
  };
}
