import { z } from 'zod';
import { router } from '@intafaced/contracts';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { drawRunInputSchema } from '@intafaced/contracts/campaigns-catalogue';
import { CAMPAIGNS_DRAW_BOARD } from '@intafaced/contracts/campaigns-procedures';
import { CampaignsError } from '../codes.js';
import { mapError, opsProcedure, refusalOf } from './kit.js';
import type { CampaignServices } from '../router.js';

/** Lucky draws (J-campaigns-12). */
export function drawRoutes({ draws }: CampaignServices) {
  return {
    customer: {
      draw: router({
        /**
         * One draw's board (J-campaigns-12): odds, prize table, the caller's own chances and the cap for their user type, the
         * seed's commitment and the entry list's hash, and why the draw does not run. The account is the signed principal's.
         */
        board: mountRecord(
          CAMPAIGNS_DRAW_BOARD,
          async ({ ctx, input }) => {
            if (!draws) throw new CampaignsError('campaigns.store_unwired', 'Draws are not wired');
            return draws.board({ campaignId: input.campaignId, accountId: ctx.principal.userId });
          },
          refusalOf,
        ),
      }),
    },
    opsCampaigns: {
      /**
       * Running and settling a draw (J-campaigns-12 #3): refused `owner.decision` while the owner's decision on chance-based
       * rewards is open; the attempt is audited with its reason and nothing is drawn or paid.
       */
      draw: router({
        run: opsProcedure
          .input(drawRunInputSchema)
          .output(z.never())
          .mutation(async ({ ctx, input }) => {
            try {
              if (!draws) throw new CampaignsError('campaigns.store_unwired', 'Draws are not wired');
              return await draws.refuseRun({ ...input, actor: ctx.principal!.userId, action: 'run' });
            } catch (err) {
              mapError(err);
            }
          }),
        settle: opsProcedure
          .input(drawRunInputSchema)
          .output(z.never())
          .mutation(async ({ ctx, input }) => {
            try {
              if (!draws) throw new CampaignsError('campaigns.store_unwired', 'Draws are not wired');
              return await draws.refuseRun({ ...input, actor: ctx.principal!.userId, action: 'settle' });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
  };
}
