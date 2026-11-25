import { z } from 'zod';
import { forwardedPrincipalHeaders } from '@intafaced/contracts/edge';
import { router } from '@intafaced/contracts/trpc';
import {
  dropCreateInputSchema,
  dropSchema,
  publishInputSchema,
  seasonCreateInputSchema,
  seasonSchema,
} from '@intafaced/contracts/campaigns-drops';
import { refuseTgeClaim } from '../tge.js';
import { mapError, opsProcedure, refusalOf } from './kit.js';
import type { CampaignServices } from '../router.js';
import { CAMPAIGNS_DROPS_ROOM, CAMPAIGNS_DROPS_CLAIM } from '@intafaced/contracts/campaigns-drops-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { CAMPAIGNS_TGE_CLAIM } from '@intafaced/contracts/campaigns-tge-procedures';

/** Seasons, limited drops and the TGE claim. */
export function dropRoutes({ drops }: CampaignServices) {
  return {
    customer: {
      drops: router({
        /** The caller's drop phase: the season and points, each published drop with the caller's own claim, the TGE panel. */
        room: mountRecord(
          CAMPAIGNS_DROPS_ROOM,
          async ({ ctx }) => {
            try {
              return await drops.room(ctx.principal!.userId, forwardedPrincipalHeaders(ctx));
            } catch (err) {
              mapError(err);
            }
          },
          refusalOf,
        ),

        /** Claims for the caller's own account only. A second call returns the first claim. */
        claim: mountRecord(
          CAMPAIGNS_DROPS_CLAIM,
          async ({ ctx, input }) => {
            try {
              return await drops.claim({
                dropId: input.dropId,
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
      tge: router({
        /** Always refuses by name and posts nothing: mainnet waits for the external audit, testnet for the schedule. */
        claim: mountRecord(
          CAMPAIGNS_TGE_CLAIM,
          ({ input }) => {
            try {
              refuseTgeClaim(input.network, drops.tgeSchedule());
            } catch (err) {
              mapError(err);
            }
          },
          refusalOf,
        ),
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
