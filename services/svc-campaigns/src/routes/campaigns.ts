import { z } from 'zod';
import { router } from '@intafaced/contracts/trpc';
import {
  campaignDefinitionInputSchema,
  campaignGetInputSchema,
  campaignSchema,
  campaignTransitionInputSchema,
  campaignUpdateInputSchema,
} from '@intafaced/contracts/campaigns-catalogue';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  CAMPAIGNS_OPS_CAMPAIGNS_CALENDAR,
  CAMPAIGNS_OPS_CAMPAIGNS_EARNING_EVALUATE,
  CAMPAIGNS_OPS_CAMPAIGNS_VALIDATE,
  CAMPAIGNS_PARTICIPATION_JOIN,
  CAMPAIGNS_PARTICIPATION_REQUEST_REVIEW,
} from '@intafaced/contracts/campaigns-procedures';
import { mapError, opsProcedure, refusalOf, requireOpsMfa } from './kit.js';
import type { CampaignServices } from '../router.js';
import {
  CAMPAIGNS_OPS_RULES_TEST,
  CAMPAIGNS_OPS_RULES_LIBRARY_SAVE,
  CAMPAIGNS_OPS_RULES_LIBRARY_LIST,
} from '@intafaced/contracts/campaigns-ops-procedures';
import { CAMPAIGNS_CATALOGUE_LIST, CAMPAIGNS_CATALOGUE_GET } from '@intafaced/contracts/campaigns-catalogue-procedures';
import { CAMPAIGNS_PARTICIPATION_MINE } from '@intafaced/contracts/campaigns-participation-procedures';

/** Campaigns themselves: the catalogue and joining for the customer; the operator's campaign desk and rule library. */
export function campaignRoutes({ campaigns }: CampaignServices) {
  return {
    customer: {
      catalogue: router({
        /** The type list, parked types with their blocker, and every published campaign with the caller's own participation. */
        list: mountRecord(
          CAMPAIGNS_CATALOGUE_LIST,
          async ({ ctx }) => {
            try {
              return await campaigns.catalogue(ctx.principal!.userId);
            } catch (err) {
              mapError(err);
            }
          },
          refusalOf,
        ),
        get: mountRecord(
          CAMPAIGNS_CATALOGUE_GET,
          async ({ ctx, input }) => {
            try {
              return await campaigns.get({ id: input.id, accountId: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          },
          refusalOf,
        ),
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
        mine: mountRecord(
          CAMPAIGNS_PARTICIPATION_MINE,
          async ({ ctx }) => {
            try {
              return await campaigns.myCampaigns(ctx.principal!.userId);
            } catch (err) {
              mapError(err);
            }
          },
          refusalOf,
        ),
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
        test: mountRecord(
          CAMPAIGNS_OPS_RULES_TEST,
          ({ input }) => {
            try {
              return campaigns.testRule(input);
            } catch (err) {
              mapError(err);
            }
          },
          { refusalOf: refusalOf, checks: { requireOpsMfa } },
        ),
        library: router({
          list: mountRecord(
            CAMPAIGNS_OPS_RULES_LIBRARY_LIST,
            async () => {
              try {
                return await campaigns.listRules();
              } catch (err) {
                mapError(err);
              }
            },
            { refusalOf: refusalOf, checks: { requireOpsMfa } },
          ),
          /** The name's next revision; the same tree again returns the revision it made. */
          save: mountRecord(
            CAMPAIGNS_OPS_RULES_LIBRARY_SAVE,
            async ({ ctx, input }) => {
              try {
                return await campaigns.saveRule({ ...input, actor: ctx.principal!.userId });
              } catch (err) {
                mapError(err);
              }
            },
            { refusalOf: refusalOf, checks: { requireOpsMfa } },
          ),
        }),
      }),
    },
  };
}
