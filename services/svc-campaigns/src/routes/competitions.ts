import { forwardedPrincipalHeaders, router, scopedProcedure } from '@intafaced/contracts';
import { competitionBoardInputSchema, competitionBoardSchema } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from '../codes.js';
import { guard, mapError } from './kit.js';
import type { CampaignServices } from '../router.js';

/** Trading competitions (J-campaigns-11). */
export function competitionRoutes({ competitions }: CampaignServices) {
  return {
    customer: {
      competition: router({
        /**
         * One competition's board (J-campaigns-11): terms, seats left, the leaderboard by venue volume, the caller's own
         * entry and milestones, and the settlement once the period closed. Forwarded so the caller's connected wallet is
         * noted for their prizes.
         */
        board: scopedProcedure('campaigns:read', guard)
          .input(competitionBoardInputSchema)
          .output(competitionBoardSchema)
          .query(async ({ ctx, input }) => {
            try {
              if (!competitions) throw new CampaignsError('campaigns.store_unwired', 'Competitions are not wired');
              return await competitions.board({
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
  };
}
