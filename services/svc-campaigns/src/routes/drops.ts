import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import {
  dropClaimInputSchema,
  dropClaimResultSchema,
  dropCreateInputSchema,
  dropRoomSchema,
  dropSchema,
  publishInputSchema,
  seasonCreateInputSchema,
  seasonSchema,
  tgeClaimInputSchema,
} from '@intafaced/contracts/campaigns-drops';
import { refuseTgeClaim } from '../tge.js';
import { guard, mapError, opsProcedure } from './kit.js';
import type { CampaignServices } from '../router.js';

/** Seasons, limited drops and the TGE claim. */
export function dropRoutes({ drops }: CampaignServices) {
  return {
    customer: {
      drops: router({
        /** The caller's drop phase: the season and points, each published drop with the caller's own claim, the TGE panel. */
        room: scopedProcedure('campaigns:read', guard)
          .output(dropRoomSchema)
          .query(async ({ ctx }) => {
            try {
              return await drops.room(ctx.principal!.userId);
            } catch (err) {
              mapError(err);
            }
          }),

        /** Claims for the caller's own account only. A second call returns the first claim. */
        claim: scopedProcedure('campaigns:write', guard)
          .input(dropClaimInputSchema)
          .output(dropClaimResultSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await drops.claim({ dropId: input.dropId, accountId: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
      tge: router({
        /** Always refuses by name and posts nothing: mainnet waits for the external audit, testnet for the schedule. */
        claim: scopedProcedure('campaigns:write', guard)
          .input(tgeClaimInputSchema)
          .output(z.never())
          .mutation(({ input }) => {
            try {
              refuseTgeClaim(input.network, drops.tgeSchedule());
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
    ops: {
      list: opsProcedure.output(z.object({ seasons: z.array(seasonSchema), drops: z.array(dropSchema) })).query(async () => {
        try {
          return await drops.listForOps();
        } catch (err) {
          mapError(err);
        }
      }),
      seasons: router({
        create: opsProcedure
          .input(seasonCreateInputSchema)
          .output(seasonSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await drops.createSeason({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
        publish: opsProcedure
          .input(publishInputSchema)
          .output(seasonSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await drops.publishSeason({ id: input.id, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
      drops: router({
        create: opsProcedure
          .input(dropCreateInputSchema)
          .output(dropSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await drops.createDrop({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
        publish: opsProcedure
          .input(publishInputSchema)
          .output(dropSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await drops.publishDrop({ id: input.id, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
  };
}
