import { router, scopedProcedure } from '@intafaced/contracts';
import { CampaignsError } from '../codes.js';
import type { RiskService } from '../risk.js';
import {
  myRiskCaseSchema,
  riskAppealDecideInputSchema,
  riskAppealInputSchema,
  riskCaseInputSchema,
  riskCaseSchema,
  riskQueueSchema,
  riskRevokeInputSchema,
  riskSignalInputSchema,
  riskSignalResultSchema,
  riskWithholdInputSchema,
} from '@intafaced/contracts/campaigns-risk';
import { guard, mapError, opsProcedure } from './kit.js';
import type { CampaignServices } from '../router.js';

/** The risk review (J-campaigns-18). */
export function riskRoutes({ risk }: CampaignServices) {
  const riskOf = (): RiskService => {
    if (!risk) throw new CampaignsError('campaigns.store_unwired', 'The risk review is not wired');
    return risk;
  };
  return {
    customer: {
      /** The signed-in customer's own risk case and their appeal (J-campaigns-18 #5). */
      risk: router({
        mine: scopedProcedure('campaigns:read', guard)
          .output(myRiskCaseSchema)
          .query(async ({ ctx }) => {
            try {
              return await riskOf().mine(ctx.principal!.userId);
            } catch (err) {
              mapError(err);
            }
          }),
        appeal: scopedProcedure('campaigns:write', guard)
          .input(riskAppealInputSchema)
          .output(myRiskCaseSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await riskOf().appeal({ accountId: ctx.principal!.userId, text: input.text });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
    ops: {
      /**
       * The risk review desk (J-campaigns-18): signals, the queue, one account's case, withholding a held reward, revoking
       * an account's rewards, and the appeal's decision by a second person. The operator is recorded from their own token.
       */
      risk: router({
        signal: opsProcedure
          .input(riskSignalInputSchema)
          .output(riskSignalResultSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await riskOf().recordSignal(input, ctx.principal!.userId);
            } catch (err) {
              mapError(err);
            }
          }),
        queue: opsProcedure.output(riskQueueSchema).query(async () => {
          try {
            return await riskOf().queue();
          } catch (err) {
            mapError(err);
          }
        }),
        case: opsProcedure
          .input(riskCaseInputSchema)
          .output(riskCaseSchema)
          .query(async ({ input }) => {
            try {
              return await riskOf().caseOf(input.accountId);
            } catch (err) {
              mapError(err);
            }
          }),
        withhold: opsProcedure
          .input(riskWithholdInputSchema)
          .output(riskCaseSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await riskOf().withhold({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
        revoke: opsProcedure
          .input(riskRevokeInputSchema)
          .output(riskCaseSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await riskOf().revoke({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
        decideAppeal: opsProcedure
          .input(riskAppealDecideInputSchema)
          .output(riskCaseSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await riskOf().decideAppeal({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
  };
}
