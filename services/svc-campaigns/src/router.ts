import { AuthError, requireMfa } from '@intafaced/auth';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, router, scopedProcedure } from '@intafaced/contracts';
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
  type CampaignsRefusalCode,
} from '@intafaced/contracts/campaigns-drops';
import { CampaignsError } from './codes.js';
import type { DropService } from './drops.js';
import { refuseTgeClaim } from './tge.js';

const guard = { module: 'campaigns', plane: 'fiat' } as const;

const STATUS: Record<CampaignsRefusalCode, TRPCError['code']> = {
  'campaigns.window_unset': 'PRECONDITION_FAILED',
  'campaigns.timezone_unset': 'BAD_REQUEST',
  'campaigns.window_invalid': 'BAD_REQUEST',
  'campaigns.second_person_required': 'FORBIDDEN',
  'campaigns.already_published': 'CONFLICT',
  'campaigns.reward_saga_unwired': 'PRECONDITION_FAILED',
  'campaigns.store_unwired': 'PRECONDITION_FAILED',
  'season.unknown': 'NOT_FOUND',
  'season.not_published': 'PRECONDITION_FAILED',
  'drop.unknown': 'NOT_FOUND',
  'drop.count_unset': 'PRECONDITION_FAILED',
  'drop.count_invalid': 'BAD_REQUEST',
  'drop.not_open': 'CONFLICT',
  'drop.sold_out': 'CONFLICT',
  'launch.schedule_unset': 'PRECONDITION_FAILED',
  'audit.external': 'PRECONDITION_FAILED',
  'chain.go': 'PRECONDITION_FAILED',
};

/** The code leads in brackets and rides `cause.code`, so the screens quote it. */
function mapError(err: unknown): never {
  if (err instanceof CampaignsError) {
    throw new TRPCError({ code: STATUS[err.code], message: `${err.message} [${err.code}]`, cause: err });
  }
  if (err instanceof AuthError) throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
  throw err;
}

/** Operator doors: `campaigns:ops` and a second factor on this session. The module's kill switch halts them too. */
const opsProcedure = scopedProcedure('campaigns:ops', guard).use(({ ctx, next }) => {
  try {
    requireMfa(ctx.principal);
  } catch (err) {
    mapError(err);
  }
  return next();
});

export function createCampaignsRouter(drops: DropService) {
  return router({
    health: publicProcedure
      .output(z.object({ ok: z.literal(true), service: z.literal('svc-campaigns') }))
      .query(() => ({ ok: true as const, service: 'svc-campaigns' as const })),

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

    ops: router({
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
    }),
  });
}

export type CampaignsRouter = ReturnType<typeof createCampaignsRouter>;
