import { forwardedPrincipalHeaders } from '@intafaced/contracts/edge';
import { router, serviceProcedureFor } from '@intafaced/contracts/trpc';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_DEACTIVATE,
  CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_ISSUE,
  CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_LIST,
  CAMPAIGNS_VOUCHERS_CLAIM,
  CAMPAIGNS_VOUCHERS_MINE,
  CAMPAIGNS_VOUCHERS_REDEEM,
  CAMPAIGNS_VOUCHERS_VALIDATE,
} from '@intafaced/contracts/campaigns-procedures';
import { FEE_SAVER_CALLERS, feeSaverAnswerSchema, feeSaverAskInputSchema } from '@intafaced/contracts/campaigns-catalogue';
import { mapError, refusalOf, requireOpsMfa, sourceOf } from './kit.js';
import type { CampaignServices } from '../router.js';

/** Vouchers: the customer's own, svc-trade's fee-saver ask, and the operator's voucher list. */
export function voucherRoutes({ campaigns, vouchers, watch }: CampaignServices) {
  return {
    customer: {
      service: router({
        /**
         * svc-trade's ask for a fee-saver coupon on one venue order (J-campaigns-09 #2 #3): quote, take once per order key,
         * or read the use an order took. Only svc-trade may call it.
         */
        feeSaver: serviceProcedureFor(FEE_SAVER_CALLERS)
          .input(feeSaverAskInputSchema)
          .output(feeSaverAnswerSchema)
          .mutation(async ({ input }) => {
            try {
              return await vouchers.feeSaver(input);
            } catch (err) {
              mapError(err);
            }
          }),
      }),

      /** My vouchers (J-campaigns-08). */
      vouchers: router({
        mine: mountRecord(CAMPAIGNS_VOUCHERS_MINE, async ({ ctx }) => vouchers.mine({ accountId: ctx.principal.userId }), refusalOf),
        validate: mountRecord(
          CAMPAIGNS_VOUCHERS_VALIDATE,
          async ({ ctx, input }) => vouchers.validate({ code: input.code, accountId: ctx.principal.userId, source: sourceOf(ctx) }),
          refusalOf,
        ),
        claim: mountRecord(
          CAMPAIGNS_VOUCHERS_CLAIM,
          async ({ ctx, input }) => vouchers.claim({ code: input.code, accountId: ctx.principal.userId, source: sourceOf(ctx) }),
          refusalOf,
        ),
        redeem: mountRecord(
          CAMPAIGNS_VOUCHERS_REDEEM,
          async ({ ctx, input }) =>
            vouchers.redeem({ ...input, accountId: ctx.principal.userId, forwarded: forwardedPrincipalHeaders(ctx) }),
          refusalOf,
        ),
      }),
    },
    opsCampaigns: {
      vouchers: router({
        list: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_LIST,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return campaigns.listVouchers(input);
          },
          refusalOf,
        ),
        issue: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_ISSUE,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return campaigns.issueVoucher({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
        deactivate: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_DEACTIVATE,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return watch.deactivate({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
      }),
    },
  };
}
