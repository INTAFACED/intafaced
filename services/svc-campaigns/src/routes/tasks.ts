import { z } from 'zod';
import { forwardedPrincipalHeaders, router, scopedProcedure } from '@intafaced/contracts';
import {
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
  welcomeChecklistSchema,
  welcomeClaimInputSchema,
  welcomeClaimResultSchema,
  welcomeListInputSchema,
} from '@intafaced/contracts/campaigns-catalogue';
import { payoutBoardInputSchema, payoutBoardSchema } from '@intafaced/contracts/campaigns-payout-board';
import { guard, mapError, opsProcedure } from './kit.js';
import type { CampaignServices } from '../router.js';

/** Task campaigns, the welcome checklist and My Rewards for the customer; the payout board and the reward pot for operators. */
export function taskRoutes({ tasks }: CampaignServices) {
  return {
    customer: {
      tasks: router({
        /** The caller's own progress on one task campaign, its claim window and its reward record with the redemption log. */
        progress: scopedProcedure('campaigns:read', guard)
          .input(taskProgressInputSchema)
          .output(taskProgressSchema)
          .query(async ({ ctx, input }) => {
            try {
              // Forwarded so a deposit step reads the person's own wallets for them (J-campaigns-02 #1).
              return await tasks.progress({
                campaignId: input.campaignId,
                accountId: ctx.principal!.userId,
                forwarded: forwardedPrincipalHeaders(ctx),
              });
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
              return await tasks.claim({
                campaignId: input.campaignId,
                accountId: ctx.principal!.userId,
                forwarded: forwardedPrincipalHeaders(ctx),
              });
            } catch (err) {
              mapError(err);
            }
          }),
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
        /**
         * The payout board (J-campaigns-19 #1 #2): every intent by where it stands (owed, pending funding, sending, paid,
         * failed, other), with its keys, its ledger transactions and its one payment's chain transaction. Read only.
         */
        board: opsProcedure
          .input(payoutBoardInputSchema)
          .output(payoutBoardSchema)
          .query(async ({ input }) => {
            try {
              return await tasks.payoutBoard(input);
            } catch (err) {
              mapError(err);
            }
          }),
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
