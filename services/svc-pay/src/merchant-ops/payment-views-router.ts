import type { Sql } from 'postgres';
import { anyScopeProcedure, router } from '@intafaced/contracts/trpc';
import {
  paymentUnmaskedSchema,
  paymentUnmaskInputSchema,
  paymentUnmaskReadPageSchema,
  paymentUnmaskReadsInputSchema,
  paymentViewCreateInputSchema,
  paymentViewDeletedSchema,
  paymentViewDeleteInputSchema,
  paymentViewSchema,
  paymentViewUpdateInputSchema,
} from '@intafaced/contracts/pay-payment-views';
import { ownMerchantRead } from '../own-merchant-read.js';
import { PAY_OR_ONBOARD, teamMemberCheck } from '../team-member-write.js';
import { MerchantOpsError, wrapOps } from './errors.js';
import { PaymentPrivacy, PaymentViews } from './payment-views.js';
import { resolveMerchantCaller } from './roles.js';
import { PAY_PAYMENT_VIEWS_LIST } from '@intafaced/contracts/pay-payment-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { payRefusal } from '../record-refusal.js';

/**
 * `payment.views.*`, `payment.unmask` and `payment.unmaskReads` (M-adv-payments-core-01), spread into the `payment`
 * router. The caller's merchant and role come from the principal, never from the body. Without a database every
 * procedure refuses `pay.merchant_ops_unavailable`; none answers empty.
 */
export function paymentPrivacyProcedures(sql: Sql | null, privacy: PaymentPrivacy | null = sql ? new PaymentPrivacy(sql) : null) {
  const parts = sql && privacy ? { sql, views: new PaymentViews(sql), privacy } : null;
  const need = () => {
    if (!parts) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return parts;
  };
  const read = ownMerchantRead();
  // A view and an unmask belong to a person on a business: pay:write for the owner, pay:onboard for an active member.
  const teamMember = teamMemberCheck(() => need().sql);
  const write = anyScopeProcedure(PAY_OR_ONBOARD, { module: 'pay', check: teamMember });
  const callerOf = (ctx: { principal: { userId: string; kid?: string | undefined; mfa?: boolean; sub_account?: string | undefined } }) =>
    resolveMerchantCaller(need().sql, ctx.principal);
  return {
    views: router({
      list: mountRecord(
        PAY_PAYMENT_VIEWS_LIST,
        ({ ctx, input }) => wrapOps(async () => need().views.list(await callerOf(ctx), input)),
        payRefusal,
      ),
      create: write
        .input(paymentViewCreateInputSchema)
        .output(paymentViewSchema)
        .mutation(({ ctx, input }) => wrapOps(async () => need().views.create(await callerOf(ctx), input))),
      update: write
        .input(paymentViewUpdateInputSchema)
        .output(paymentViewSchema)
        .mutation(({ ctx, input }) => wrapOps(async () => need().views.update(await callerOf(ctx), input))),
      delete: write
        .input(paymentViewDeleteInputSchema)
        .output(paymentViewDeletedSchema)
        .mutation(({ ctx, input }) => wrapOps(async () => need().views.remove(await callerOf(ctx), input))),
    }),
    /** One clear payer detail, with a reason, written to the audit first. */
    unmask: write
      .input(paymentUnmaskInputSchema)
      .output(paymentUnmaskedSchema)
      .mutation(({ ctx, input }) => wrapOps(async () => need().privacy.unmask(await callerOf(ctx), input))),
    /** The audit of clear values shown: who, which payment, which field, why. Owner and admins. */
    unmaskReads: read
      .input(paymentUnmaskReadsInputSchema)
      .output(paymentUnmaskReadPageSchema)
      .query(({ ctx, input }) => wrapOps(async () => need().privacy.reads(await callerOf(ctx), input))),
  };
}
