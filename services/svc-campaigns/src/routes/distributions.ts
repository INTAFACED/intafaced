import { forwardedPrincipalHeaders, router } from '@intafaced/contracts';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_PLAN,
  CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_RUN,
} from '@intafaced/contracts/campaigns-procedures';
import { CampaignsError } from '../codes.js';
import { mapError, refusalOf, requireOpsMfa } from './kit.js';
import type { CampaignServices } from '../router.js';
import { CAMPAIGNS_DISTRIBUTION_MINE } from '@intafaced/contracts/campaigns-distribution-procedures';

/** Airdrop distributions (J-campaigns-13, J-campaigns-19 #5 #6). */
export function distributionRoutes({ distributions }: CampaignServices) {
  return {
    customer: {
      distribution: router({
        /**
         * The caller's own distributions (J-campaigns-13 #1 #2 #3): each airdrop they joined, how they stood at its snapshot,
         * their share and the chain transaction that paid it. Dividends refuse `owner.decision` naming the question.
         */
        mine: mountRecord(
          CAMPAIGNS_DISTRIBUTION_MINE,
          async ({ ctx, input }) => {
            try {
              if (!distributions) throw new CampaignsError('campaigns.store_unwired', 'Distributions are not wired');
              return await distributions.mine({
                kind: input.kind,
                accountId: ctx.principal!.userId,
                forwarded: forwardedPrincipalHeaders(ctx),
              });
            } catch (err) {
              mapError(err);
            }
          },
          refusalOf,
        ),
      }),
    },
    opsCampaigns: {
      /**
       * An airdrop's snapshot (J-campaigns-13 #2): taken now if it is due, or resumed where it stopped; run again it
       * returns the run as it stands and owes nothing twice. The operator and their reason are audited.
       */
      distribution: router({
        plan: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_PLAN,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            if (!distributions) throw new CampaignsError('campaigns.store_unwired', 'Distributions are not wired');
            return distributions.plan(input.campaignId);
          },
          refusalOf,
        ),
        run: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_RUN,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            if (!distributions) throw new CampaignsError('campaigns.store_unwired', 'Distributions are not wired');
            return distributions.run(input.campaignId, { actor: ctx.principal.userId, reason: input.reason });
          },
          refusalOf,
        ),
      }),
    },
  };
}
