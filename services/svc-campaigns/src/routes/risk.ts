import { router, scopedProcedure } from '@intafaced/contracts/trpc';
import { CampaignsError } from '../codes.js';
import type { RiskService } from '../risk.js';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  CAMPAIGNS_OPS_RISK_CASE,
  CAMPAIGNS_OPS_RISK_DECIDE_APPEAL,
  CAMPAIGNS_OPS_RISK_QUEUE,
  CAMPAIGNS_OPS_RISK_REVOKE,
  CAMPAIGNS_OPS_RISK_WITHHOLD,
} from '@intafaced/contracts/campaigns-procedures';
import {
  myRiskCaseSchema,
  riskAppealInputSchema,
  riskSignalInputSchema,
  riskSignalResultSchema,
} from '@intafaced/contracts/campaigns-risk';
import { guard, mapError, opsProcedure, refusalOf, requireOpsMfa } from './kit.js';
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
        queue: mountRecord(
          CAMPAIGNS_OPS_RISK_QUEUE,
          async ({ ctx }) => {
            requireOpsMfa(ctx);
            return riskOf().queue();
          },
          refusalOf,
        ),
        case: mountRecord(
          CAMPAIGNS_OPS_RISK_CASE,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return riskOf().caseOf(input.accountId);
          },
          refusalOf,
        ),
        withhold: mountRecord(
          CAMPAIGNS_OPS_RISK_WITHHOLD,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return riskOf().withhold({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
        revoke: mountRecord(
          CAMPAIGNS_OPS_RISK_REVOKE,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return riskOf().revoke({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
        decideAppeal: mountRecord(
          CAMPAIGNS_OPS_RISK_DECIDE_APPEAL,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return riskOf().decideAppeal({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
      }),
    },
  };
}
