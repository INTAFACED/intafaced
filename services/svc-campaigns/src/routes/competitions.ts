import { forwardedPrincipalHeaders } from '@intafaced/contracts/edge';
import { router } from '@intafaced/contracts/trpc';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { CAMPAIGNS_COMPETITION_BOARD } from '@intafaced/contracts/campaigns-procedures';
import { CampaignsError } from '../codes.js';
import { refusalOf } from './kit.js';
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
        board: mountRecord(
          CAMPAIGNS_COMPETITION_BOARD,
          async ({ ctx, input }) => {
            if (!competitions) throw new CampaignsError('campaigns.store_unwired', 'Competitions are not wired');
            return competitions.board({
              campaignId: input.campaignId,
              accountId: ctx.principal.userId,
              forwarded: forwardedPrincipalHeaders(ctx),
            });
          },
          refusalOf,
        ),
      }),
    },
  };
}
