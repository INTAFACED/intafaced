import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import {
  campaignCatalogueSchema,
  campaignDefinitionInputSchema,
  campaignGetInputSchema,
  ruleLibraryEntrySchema,
  ruleLibrarySaveInputSchema,
  ruleTestInputSchema,
  ruleTestResultSchema,
  campaignSchema,
  campaignTransitionInputSchema,
  campaignUpdateInputSchema,
  campaignViewSchema,
  myCampaignsSchema,
} from '@intafaced/contracts/campaigns-catalogue';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  CAMPAIGNS_OPS_CAMPAIGNS_CALENDAR,
  CAMPAIGNS_OPS_CAMPAIGNS_EARNING_EVALUATE,
  CAMPAIGNS_OPS_CAMPAIGNS_VALIDATE,
  CAMPAIGNS_PARTICIPATION_JOIN,
  CAMPAIGNS_PARTICIPATION_REQUEST_REVIEW,
} from '@intafaced/contracts/campaigns-procedures';
import { guard, mapError, opsProcedure, refusalOf, requireOpsMfa } from './kit.js';
import type { CampaignServices } from '../router.js';

/** Campaigns themselves: the catalogue and joining for the customer; the operator's campaign desk and rule library. */
export function campaignRoutes({ campaigns }: CampaignServices) {
  return {
    customer: {
      catalogue: router({
        /** The type list, parked types with their blocker, and every published campaign with the caller's own participation. */
        list: scopedProcedure('campaigns:read', guard)
          .output(campaignCatalogueSchema)
          .query(async ({ ctx }) => {
            try {
              return await campaigns.catalogue(ctx.principal!.userId);
            } catch (err) {
              mapError(err);
            }
          }),
        get: scopedProcedure('campaigns:read', guard)
          .input(campaignGetInputSchema)
          .output(campaignViewSchema)
          .query(async ({ ctx, input }) => {
            try {
              return await campaigns.get({ id: input.id, accountId: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
      participation: router({
        join: mountRecord(
          CAMPAIGNS_PARTICIPATION_JOIN,
          async ({ ctx, input }) => campaigns.join({ campaignId: input.campaignId, accountId: ctx.principal.userId }),
          refusalOf,
        ),
        requestReview: mountRecord(
          CAMPAIGNS_PARTICIPATION_REQUEST_REVIEW,
          async ({ ctx, input }) => campaigns.requestReview({ campaignId: input.campaignId, accountId: ctx.principal.userId }),
          refusalOf,
        ),
        mine: scopedProcedure('campaigns:read', guard)
          .output(myCampaignsSchema)
          .query(async ({ ctx }) => {
            try {
              return await campaigns.myCampaigns(ctx.principal!.userId);
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
    opsCampaigns: {
      list: opsProcedure.output(z.array(campaignSchema)).query(async () => {
        try {
          return await campaigns.listForOps();
        } catch (err) {
          mapError(err);
        }
      }),
      /** One campaign by id, at any age (the list is the newest 200). */
      get: opsProcedure
        .input(campaignGetInputSchema)
        .output(campaignSchema)
        .query(async ({ input }) => {
          try {
            return await campaigns.getForOps(input);
          } catch (err) {
            mapError(err);
          }
        }),
      calendar: mountRecord(
        CAMPAIGNS_OPS_CAMPAIGNS_CALENDAR,
        async ({ ctx }) => {
          requireOpsMfa(ctx);
          return campaigns.calendar();
        },
        refusalOf,
      ),
      create: opsProcedure
        .input(campaignDefinitionInputSchema)
        .output(campaignSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await campaigns.create({ definition: input, actor: ctx.principal!.userId });
          } catch (err) {
            mapError(err);
          }
        }),
      update: opsProcedure
        .input(campaignUpdateInputSchema)
        .output(campaignSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await campaigns.update({ ...input, actor: ctx.principal!.userId });
          } catch (err) {
            mapError(err);
          }
        }),
      validate: mountRecord(
        CAMPAIGNS_OPS_CAMPAIGNS_VALIDATE,
        async ({ ctx, input }) => {
          requireOpsMfa(ctx);
          return campaigns.validate(input);
        },
        refusalOf,
      ),
      /** submit, approve (a second person), activate, pause, resume, end, close, archive. */
      transition: opsProcedure
        .input(campaignTransitionInputSchema)
        .output(campaignSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await campaigns.transition({ ...input, actor: ctx.principal!.userId });
          } catch (err) {
            mapError(err);
          }
        }),
      earning: router({
        evaluate: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_EARNING_EVALUATE,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return campaigns.evaluateEarning(input);
          },
          refusalOf,
        ),
      }),
    },
    ops: {
      rules: router({
        /** Tries a tree on a TEST fixture account: every failing condition by its place. Reads no account, stores nothing. */
        test: opsProcedure
          .input(ruleTestInputSchema)
          .output(ruleTestResultSchema)
          .query(({ input }) => {
            try {
              return campaigns.testRule(input);
            } catch (err) {
              mapError(err);
            }
          }),
        library: router({
          list: opsProcedure.output(z.array(ruleLibraryEntrySchema)).query(async () => {
            try {
              return await campaigns.listRules();
            } catch (err) {
              mapError(err);
            }
          }),
          /** The name's next revision; the same tree again returns the revision it made. */
          save: opsProcedure
            .input(ruleLibrarySaveInputSchema)
            .output(ruleLibraryEntrySchema)
            .mutation(async ({ ctx, input }) => {
              try {
                return await campaigns.saveRule({ ...input, actor: ctx.principal!.userId });
              } catch (err) {
                mapError(err);
              }
            }),
        }),
      }),
    },
  };
}
