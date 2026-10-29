import type { Sql } from 'postgres';
import { router } from '@intafaced/contracts';
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
import { z } from 'zod';
import { ownMerchantRead } from '../own-merchant-read.js';
import { teamMemberWrite } from '../team-member-write.js';
import { MerchantOpsError, wrapOps } from './errors.js';
import { cursorInput, limitInput } from './pagination.js';
import { PaymentPrivacy, PaymentViews } from './payment-views.js';
import { resolveMerchantCaller } from './roles.js';

/**
 * `payment.views.*`, `payment.unmask` and `payment.unmaskReads` (M-adv-payments-core-01), spread into the `payment`
 * router. The caller's merchant and role come from the principal, never from the body. Without a database every
 * procedure refuses `pay.merchant_ops_unavailable`; none answers empty.
 */
export function paymentPrivacyProcedures(sql: Sql | null) {
  const parts = sql ? { sql, views: new PaymentViews(sql), privacy: new PaymentPrivacy(sql) } : null;
  const need = () => {
    if (!parts) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return parts;
  };
  const read = ownMerchantRead();
  // A view and an unmask belong to a person on a business: pay:write for the owner, pay:onboard for an active member.
  const write = teamMemberWrite(() => need().sql);
  const callerOf = (ctx: { principal: { userId: string; kid?: string | undefined; mfa?: boolean; sub_account?: string | undefined } }) =>
    resolveMerchantCaller(need().sql, ctx.principal);
  return {
    views: router({
      list: read
        .input(z.object({ limit: limitInput, cursor: cursorInput }).strict())
        .output(z.object({ items: z.array(paymentViewSchema), nextCursor: z.string().nullable() }).strict())
        .query(({ ctx, input }) => wrapOps(async () => need().views.list(await callerOf(ctx), input))),
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
