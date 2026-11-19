import { forwardedPrincipalHeaders, router, scopedProcedure } from '@intafaced/contracts';
import {
  distributionRunInputSchema,
  distributionRunSchema,
  distributionsMineInputSchema,
  distributionsMineSchema,
} from '@intafaced/contracts/campaigns-catalogue';
import { distributionPlanInputSchema, distributionPlanSchema } from '@intafaced/contracts/campaigns-payout-board';
import { CampaignsError } from '../codes.js';
import { guard, mapError, opsProcedure } from './kit.js';
import type { CampaignServices } from '../router.js';

/** Airdrop distributions (J-campaigns-13, J-campaigns-19 #5 #6). */
export function distributionRoutes({ distributions }: CampaignServices) {
  return {
    customer: {
      distribution: router({
        /**
         * The caller's own distributions (J-campaigns-13 #1 #2 #3): each airdrop they joined, how they stood at its snapshot,
         * their share and the chain transaction that paid it. Dividends refuse `owner.decision` naming the question.
         */
        mine: scopedProcedure('campaigns:read', guard)
          .input(distributionsMineInputSchema)
          .output(distributionsMineSchema)
          .query(async ({ ctx, input }) => {
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
          }),
      }),
    },
    opsCampaigns: {
      /**
       * An airdrop's snapshot (J-campaigns-13 #2): taken now if it is due, or resumed where it stopped; run again it
       * returns the run as it stands and owes nothing twice. The operator and their reason are audited.
       */
      distribution: router({
        /** An airdrop's plan, account by account (J-campaigns-19 #5 #6): the run as it stands. Read only. */
        plan: opsProcedure
          .input(distributionPlanInputSchema)
          .output(distributionPlanSchema)
          .query(async ({ input }) => {
            try {
              if (!distributions) throw new CampaignsError('campaigns.store_unwired', 'Distributions are not wired');
              return await distributions.plan(input.campaignId);
            } catch (err) {
              mapError(err);
            }
          }),
        run: opsProcedure
          .input(distributionRunInputSchema)
          .output(distributionRunSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              if (!distributions) throw new CampaignsError('campaigns.store_unwired', 'Distributions are not wired');
              return await distributions.run(input.campaignId, { actor: ctx.principal!.userId, reason: input.reason });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
  };
}
