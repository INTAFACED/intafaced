import { z } from 'zod';
import { forwardedPrincipalHeaders, router, scopedProcedure } from '@intafaced/contracts';
import {
  myRewardsInputSchema,
  myRewardsSchema,
  payoutRecordListSchema,
  potFundingApproveInputSchema,
  potFundingRequestInputSchema,
  potFundingSchema,
  welcomeChecklistSchema,
  welcomeClaimInputSchema,
  welcomeClaimResultSchema,
  welcomeListInputSchema,
} from '@intafaced/contracts/campaigns-catalogue';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { CAMPAIGNS_OPS_PAYOUTS_BOARD, CAMPAIGNS_TASKS_CLAIM, CAMPAIGNS_TASKS_PROGRESS } from '@intafaced/contracts/campaigns-procedures';
import { guard, mapError, opsProcedure, refusalOf, requireOpsMfa } from './kit.js';
import type { CampaignServices } from '../router.js';

/** Task campaigns, the welcome checklist and My Rewards for the customer; the payout board and the reward pot for operators. */
export function taskRoutes({ tasks }: CampaignServices) {
  return {
    customer: {
      tasks: router({
        progress: mountRecord(
          CAMPAIGNS_TASKS_PROGRESS,
          // Forwarded so a deposit step reads the person's own wallets for them (J-campaigns-02 #1).
          async ({ ctx, input }) =>
            tasks.progress({ campaignId: input.campaignId, accountId: ctx.principal.userId, forwarded: forwardedPrincipalHeaders(ctx) }),
          refusalOf,
        ),
        claim: mountRecord(
          CAMPAIGNS_TASKS_CLAIM,
          async ({ ctx, input }) =>
            tasks.claim({ campaignId: input.campaignId, accountId: ctx.principal.userId, forwarded: forwardedPrincipalHeaders(ctx) }),
          refusalOf,
        ),
        welcome: router({
          /** The caller's own welcome checklist (CM-rewards-hub-03): its window and each task's state and reward. */
          list: scopedProcedure('campaigns:read', guard)
            .input(welcomeListInputSchema)
            .output(welcomeChecklistSchema)
            .query(async ({ ctx }) => {
              try {
                return await tasks.welcomeChecklist({ accountId: ctx.principal!.userId, forwarded: forwardedPrincipalHeaders(ctx) });
              } catch (err) {
                mapError(err);
              }
            }),
          /** Claims one welcome task for the caller's own account. A second call returns the first claim's reward. */
          claim: scopedProcedure('campaigns:write', guard)
            .input(welcomeClaimInputSchema)
            .output(welcomeClaimResultSchema)
            .mutation(async ({ ctx, input }) => {
              try {
                return await tasks.welcomeClaim({
                  accountId: ctx.principal!.userId,
                  event: input.event,
                  forwarded: forwardedPrincipalHeaders(ctx),
                });
              } catch (err) {
                mapError(err);
              }
            }),
        }),
      }),

      rewards: router({
        /** My Rewards hub: the caller's own rewards in plain status words, with totals summed from those rows. */
        mine: scopedProcedure('campaigns:read', guard)
          .input(myRewardsInputSchema)
          .output(myRewardsSchema)
          .query(async ({ ctx }) => {
            try {
              return await tasks.myRewards({ accountId: ctx.principal!.userId, forwarded: forwardedPrincipalHeaders(ctx) });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
    ops: {
      payouts: router({
        board: mountRecord(
          CAMPAIGNS_OPS_PAYOUTS_BOARD,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return tasks.payoutBoard(input);
          },
          refusalOf,
        ),
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
    },
  };
}
