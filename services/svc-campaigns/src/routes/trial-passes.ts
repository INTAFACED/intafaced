import { router } from '@intafaced/contracts';
import { trialPassGrantInputSchema, trialPassGrantSchema } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from '../codes.js';
import { mapError, opsProcedure } from './kit.js';
import type { CampaignServices } from '../router.js';

/** VIP trial passes granted as a reward (J-campaigns-14). */
export function trialPassRoutes({ trialPasses }: CampaignServices) {
  return {
    opsCampaigns: {
      /**
       * A VIP trial pass granted as a campaign's reward (J-campaigns-14 #2 #3): the live `trial_pass` campaign's tier,
       * for its span, to one account, once per campaign and account; a later pass replaces the one in force. svc-trade
       * holds it and charges the account's orders at its tier. The operator and their reason are audited.
       */
      trialPass: router({
        grant: opsProcedure
          .input(trialPassGrantInputSchema)
          .output(trialPassGrantSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              if (!trialPasses) throw new CampaignsError('campaigns.store_unwired', 'Trial passes are not wired');
              return await trialPasses.grant(input.campaignId, input.accountId, { actor: ctx.principal!.userId, reason: input.reason });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
  };
}
