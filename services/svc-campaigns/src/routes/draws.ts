import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { drawBoardInputSchema, drawBoardSchema, drawRunInputSchema } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from '../codes.js';
import { guard, mapError, opsProcedure } from './kit.js';
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
        board: scopedProcedure('campaigns:read', guard)
          .input(drawBoardInputSchema)
          .output(drawBoardSchema)
          .query(async ({ ctx, input }) => {
            try {
              if (!draws) throw new CampaignsError('campaigns.store_unwired', 'Draws are not wired');
              return await draws.board({ campaignId: input.campaignId, accountId: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
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
