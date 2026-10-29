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
  myRewardsInputSchema,
  myRewardsSchema,
  payoutRecordListSchema,
  potFundingApproveInputSchema,
  potFundingRequestInputSchema,
  potFundingSchema,
  taskClaimInputSchema,
  taskClaimResultSchema,
  taskProgressInputSchema,
  taskProgressSchema,
  type CampaignRefusalCode,
  campaignVoucherSchema,
  voucherIssueInputSchema,
  voucherListInputSchema,
} from '@intafaced/contracts/campaigns-catalogue';
import type { CampaignService } from './campaigns.js';
import { CampaignsError } from './codes.js';
import type { DropService } from './drops.js';
import type { TaskService } from './tasks.js';
import { refuseTgeClaim } from './tge.js';

const guard = { module: 'campaigns', plane: 'fiat' } as const;

const STATUS: Record<CampaignsRefusalCode | CampaignRefusalCode, TRPCError['code']> = {
  'campaign.unknown': 'NOT_FOUND',
  'campaign.name_taken': 'CONFLICT',
  'campaign.type_unknown': 'BAD_REQUEST',
  'campaign.invalid_transition': 'CONFLICT',
  'campaign.revision_conflict': 'CONFLICT',
  'campaign.not_draft': 'CONFLICT',
  'campaign.not_active': 'CONFLICT',
  'campaign.outside_window': 'CONFLICT',
  'campaign.archive_active': 'CONFLICT',
  'campaign.type_locked': 'CONFLICT',
  'campaigns.rule_depth_unset': 'PRECONDITION_FAILED',
  'campaigns.rule_size_unset': 'PRECONDITION_FAILED',
  'campaigns.rule_too_deep': 'BAD_REQUEST',
  'campaigns.rule_too_large': 'BAD_REQUEST',
  'campaigns.rule_empty_group': 'BAD_REQUEST',
  'campaigns.rule_unknown': 'BAD_REQUEST',
  'campaigns.formula_invalid': 'BAD_REQUEST',
  'campaigns.trigger_unknown': 'BAD_REQUEST',
  'campaigns.earning_rule_name_taken': 'CONFLICT',
  'campaigns.budget_below_drawn': 'CONFLICT',
  'campaigns.budget_unset': 'PRECONDITION_FAILED',
  'campaigns.number_on_wire': 'BAD_REQUEST',
  'campaigns.rules_unset': 'PRECONDITION_FAILED',
  'campaigns.time_frame_unset': 'PRECONDITION_FAILED',
  'campaigns.reward_unset': 'PRECONDITION_FAILED',
  'campaigns.approval_required': 'PRECONDITION_FAILED',
  'campaigns.eligibility_unwired': 'PRECONDITION_FAILED',
  'campaigns.region_list_unset': 'PRECONDITION_FAILED',
  'campaigns.not_eligible': 'FORBIDDEN',
  'campaigns.region_blocked': 'FORBIDDEN',
  'campaigns.participant_unread': 'SERVICE_UNAVAILABLE',
  'campaigns.review_not_needed': 'CONFLICT',
  'campaigns.tasks_invalid': 'BAD_REQUEST',
  'campaigns.claim_window_unset': 'PRECONDITION_FAILED',
  'campaigns.hold_period_unset': 'PRECONDITION_FAILED',
  'campaigns.lock_period_unset': 'PRECONDITION_FAILED',
  'campaigns.bonus_expiry_unset': 'PRECONDITION_FAILED',
  'campaigns.bonus_scope_unset': 'PRECONDITION_FAILED',
  'campaigns.no_tasks': 'NOT_FOUND',
  'campaigns.not_joined': 'PRECONDITION_FAILED',
  'campaigns.tasks_incomplete': 'PRECONDITION_FAILED',
  'campaigns.kyc_required': 'FORBIDDEN',
  'campaigns.claim_expired': 'CONFLICT',
  'campaigns.budget_exhausted': 'CONFLICT',
  'campaigns.budget_asset_mismatch': 'PRECONDITION_FAILED',
  'campaigns.funding_unknown': 'NOT_FOUND',
  'campaigns.funding_reference_taken': 'CONFLICT',
  'campaigns.not_voucher': 'CONFLICT',
  'owner.decision': 'PRECONDITION_FAILED',
  'campaigns.window_unset': 'PRECONDITION_FAILED',
  'campaigns.timezone_unset': 'BAD_REQUEST',
  'campaigns.timezone_not_platform': 'BAD_REQUEST',
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

export function createCampaignsRouter(drops: DropService, campaigns: CampaignService, tasks: TaskService) {
  return router({
    health: publicProcedure
      .output(z.object({ ok: z.literal(true), service: z.literal('svc-campaigns') }))
      .query(() => ({ ok: true as const, service: 'svc-campaigns' as const })),

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

    tasks: router({
      /** The caller's own progress on one task campaign, its claim window and its reward record with the redemption log. */
      progress: scopedProcedure('campaigns:read', guard)
        .input(taskProgressInputSchema)
        .output(taskProgressSchema)
        .query(async ({ ctx, input }) => {
          try {
            return await tasks.progress({ campaignId: input.campaignId, accountId: ctx.principal!.userId });
          } catch (err) {
            mapError(err);
          }
        }),
      /** Claims for the caller's own account only. A second call returns the first claim's reward. */
      claim: scopedProcedure('campaigns:write', guard)
        .input(taskClaimInputSchema)
        .output(taskClaimResultSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await tasks.claim({ campaignId: input.campaignId, accountId: ctx.principal!.userId });
          } catch (err) {
            mapError(err);
          }
        }),
    }),

    rewards: router({
      /** My Rewards hub: the caller's own rewards in plain status words, with totals summed from those rows. */
      mine: scopedProcedure('campaigns:read', guard)
        .input(myRewardsInputSchema)
        .output(myRewardsSchema)
        .query(async ({ ctx }) => {
          try {
            return await tasks.myRewards({ accountId: ctx.principal!.userId });
          } catch (err) {
            mapError(err);
          }
        }),
    }),

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
      campaigns: router({
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
        vouchers: router({
          /** A voucher campaign's vouchers, each with the revision and face value it was issued under. */
          list: opsProcedure
            .input(voucherListInputSchema)
            .output(z.array(campaignVoucherSchema))
            .query(async ({ input }) => {
              try {
                return await campaigns.listVouchers(input);
              } catch (err) {
                mapError(err);
              }
            }),
          /** Publishes one voucher under the live revision; the same code again returns it. */
          issue: opsProcedure
            .input(voucherIssueInputSchema)
            .output(campaignVoucherSchema)
            .mutation(async ({ ctx, input }) => {
              try {
                return await campaigns.issueVoucher({ ...input, actor: ctx.principal!.userId });
              } catch (err) {
                mapError(err);
              }
            }),
        }),
      }),
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
      payouts: router({
        /** Every reward record with its account, state, ledger transaction and attempts. */
        list: opsProcedure
          .input(z.object({ campaignId: z.string().min(1).max(128).optional() }).strict())
          .output(payoutRecordListSchema)
          .query(async ({ input }) => {
            try {
              return await tasks.payoutRecords(input);
            } catch (err) {
              mapError(err);
            }
          }),
      }),
      pot: router({
        list: opsProcedure.output(z.array(potFundingSchema)).query(async () => {
          try {
            return await tasks.fundings();
          } catch (err) {
            mapError(err);
          }
        }),
        /** One operator asks to sweep earned fees into the reward pot. */
        request: opsProcedure
          .input(potFundingRequestInputSchema)
          .output(potFundingSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await tasks.requestFunding({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
        /** A different operator approves, which posts the sweep. */
        approve: opsProcedure
          .input(potFundingApproveInputSchema)
          .output(potFundingSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await tasks.approveFunding({ reference: input.reference, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
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
