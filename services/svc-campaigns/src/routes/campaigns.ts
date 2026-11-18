import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import {
  campaignCalendarSchema,
  campaignCatalogueSchema,
  campaignDefinitionInputSchema,
  campaignGateSchema,
  campaignGetInputSchema,
  ruleLibraryEntrySchema,
  ruleLibrarySaveInputSchema,
  ruleTestInputSchema,
  ruleTestResultSchema,
  campaignJoinInputSchema,
  campaignJoinResultSchema,
  campaignReviewInputSchema,
  campaignReviewResultSchema,
  campaignSchema,
  campaignTransitionInputSchema,
  campaignUpdateInputSchema,
  campaignViewSchema,
  myCampaignsSchema,
  earningEvaluateInputSchema,
  earningEvaluationSchema,
} from '@intafaced/contracts/campaigns-catalogue';
import { guard, mapError, opsProcedure } from './kit.js';
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
        /** Joins for the caller's own account only. A second call returns the first participation. */
        join: scopedProcedure('campaigns:write', guard)
          .input(campaignJoinInputSchema)
          .output(campaignJoinResultSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await campaigns.join({ campaignId: input.campaignId, accountId: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
        /** One eligibility review request for the caller's own account, for a campaign whose rules refuse them. */
        requestReview: scopedProcedure('campaigns:write', guard)
          .input(campaignReviewInputSchema)
          .output(campaignReviewResultSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await campaigns.requestReview({ campaignId: input.campaignId, accountId: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
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
      calendar: opsProcedure.output(campaignCalendarSchema).query(async () => {
        try {
          return await campaigns.calendar();
        } catch (err) {
          mapError(err);
        }
      }),
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
      validate: opsProcedure
        .input(campaignGetInputSchema)
        .output(campaignGateSchema)
        .query(async ({ input }) => {
          try {
            return await campaigns.validate(input);
          } catch (err) {
            mapError(err);
          }
        }),
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
        /** Each earning rule's answer to one TEST event; writes nothing. A points rule refuses for itself only. */
        evaluate: opsProcedure
          .input(earningEvaluateInputSchema)
          .output(earningEvaluationSchema)
          .query(async ({ input }) => {
            try {
              return await campaigns.evaluateEarning(input);
            } catch (err) {
              mapError(err);
            }
          }),
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
