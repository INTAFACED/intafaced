import { forwardedPrincipalHeaders, router, scopedProcedure } from '@intafaced/contracts';
import { poolBoardInputSchema, poolBoardSchema, poolSettleInputSchema, poolSettleSchema } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from '../codes.js';
import { guard, mapError, opsProcedure } from './kit.js';
import type { CampaignServices } from '../router.js';

/** Daily reward pools (J-campaigns-13 #4 #5). */
export function poolRoutes({ pools }: CampaignServices) {
  return {
    customer: {
      pool: router({
        /**
         * One reward pool's board (J-campaigns-13 #4 #5): its terms, each day with the caller's share once settled, and today
         * with the caller's venue balance read now. The account is the signed principal's.
         */
        board: scopedProcedure('campaigns:read', guard)
          .input(poolBoardInputSchema)
          .output(poolBoardSchema)
          .query(async ({ ctx, input }) => {
            try {
              if (!pools) throw new CampaignsError('campaigns.store_unwired', 'Reward pools are not wired');
              return await pools.board({
                campaignId: input.campaignId,
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
       * Settling one ended day of a reward pool (J-campaigns-13 #5), once: settled again it returns the day as it was
       * settled and owes nothing twice. The operator and their reason are audited.
       */
      pool: router({
        settle: opsProcedure
          .input(poolSettleInputSchema)
          .output(poolSettleSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              if (!pools) throw new CampaignsError('campaigns.store_unwired', 'Reward pools are not wired');
              return await pools.settle(input.campaignId, input.day, { actor: ctx.principal!.userId, reason: input.reason });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
  };
}
