import { z } from 'zod';
import { forwardedPrincipalHeaders, router, scopedProcedure, serviceProcedureFor } from '@intafaced/contracts';
import {
  myVoucherSchema,
  myVouchersSchema,
  voucherCodeInputSchema,
  voucherRedeemInputSchema,
  voucherRedeemResultSchema,
  voucherValidationSchema,
  campaignVoucherSchema,
  FEE_SAVER_CALLERS,
  feeSaverAnswerSchema,
  feeSaverAskInputSchema,
  voucherIssueInputSchema,
  voucherListInputSchema,
} from '@intafaced/contracts/campaigns-catalogue';
import { voucherDeactivateInputSchema, watchVoucherSchema } from '@intafaced/contracts/campaigns-watch';
import { guard, mapError, opsProcedure, sourceOf } from './kit.js';
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

      vouchers: router({
        /** My vouchers (J-campaigns-08): the caller's own, newest claim first, with what is left and every redemption. */
        mine: scopedProcedure('campaigns:read', guard)
          .input(z.object({}).strict().optional())
          .output(myVouchersSchema)
          .query(async ({ ctx }) => {
            try {
              return await vouchers.mine({ accountId: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
        /** What a code would give the caller; changes nothing. A code the caller may not claim is the generic refusal. */
        validate: scopedProcedure('campaigns:read', guard)
          .input(voucherCodeInputSchema)
          .output(voucherValidationSchema)
          .query(async ({ ctx, input }) => {
            try {
              return await vouchers.validate({ code: input.code, accountId: ctx.principal!.userId, source: sourceOf(ctx) });
            } catch (err) {
              mapError(err);
            }
          }),
        /** Claims a code for the caller's own account only. */
        claim: scopedProcedure('campaigns:write', guard)
          .input(voucherCodeInputSchema)
          .output(myVoucherSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await vouchers.claim({ code: input.code, accountId: ctx.principal!.userId, source: sourceOf(ctx) });
            } catch (err) {
              mapError(err);
            }
          }),
        /** The n-th redemption of the caller's own voucher; the same one again returns the first. */
        redeem: scopedProcedure('campaigns:write', guard)
          .input(voucherRedeemInputSchema)
          .output(voucherRedeemResultSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await vouchers.redeem({ ...input, accountId: ctx.principal!.userId, forwarded: forwardedPrincipalHeaders(ctx) });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
    opsCampaigns: {
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
        /** Deactivates one voucher: its claim and every later use refuse (J-campaigns-17 #5). */
        deactivate: opsProcedure
          .input(voucherDeactivateInputSchema)
          .output(watchVoucherSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await watch.deactivate({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
  };
}
