import { z } from 'zod';
import { TRPCError, router, scopedProcedure } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { MerchantOpsError, wrapOps } from '../merchant-ops/errors.js';
import { resolveMerchantCaller } from '../merchant-ops/roles.js';
import { RECEIPT_KINDS, ReceiptNotConnected, ReceiptService } from './receipt.js';
import { CustomerEmailSettingsService } from './settings.js';

/**
 * `merchant.customerEmails.*` stores the switches.
 * `payments.receipt.*` reads a payment's real amounts and refuses send while
 * email delivery is not connected (`vendor.email`). No address is stored.
 *
 * `createPayRouter` already owns `merchant`. The switches mount through
 * `merchantPortalExtensions`. Only `payments` is merged from the namespace router.
 */
function customerEmailParts(deps: { readonly sql?: Sql }) {
  const read = scopedProcedure('pay:read', { module: 'pay' });
  const write = scopedProcedure('pay:write', { module: 'pay' });
  const need = () => {
    if (!deps.sql) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return deps.sql;
  };
  const callerOf = (ctx: { principal: { userId: string; kid?: string | undefined; mfa?: boolean; sub_account?: string | undefined } }) =>
    resolveMerchantCaller(need(), ctx.principal);
  const settings = () => new CustomerEmailSettingsService(need());
  const receipts = () => new ReceiptService(need());

  const settingsView = z
    .object({
      receipts: z.boolean().nullable(),
      refunds: z.boolean().nullable(),
      invoices: z.boolean().nullable(),
      updatedAt: z.string().nullable(),
      automaticReceipts: z.enum(['stopped', 'not_connected']),
    })
    .strict();

  const previewView = z
    .object({
      paymentId: z.string().uuid(),
      status: z.string(),
      currency: z.string(),
      authorizedAmount: z.string(),
      capturedAmount: z.string(),
      refundedAmount: z.string(),
      hasCapture: z.boolean(),
      paymentReceipt: z.enum(['offered', 'not_offered', 'not_paid']),
      refundReceipt: z.enum(['offered', 'not_refunded']),
      delivery: z.object({ status: z.literal('not_connected'), notConnected: z.literal('vendor.email') }).strict(),
    })
    .strict();

  const customerEmails = router({
    get: read.output(settingsView).query(({ ctx }) => wrapReceipt(async () => settings().get(await callerOf(ctx)))),
    set: write
      .input(
        z
          .object({
            receipts: z.boolean().optional(),
            refunds: z.boolean().optional(),
            invoices: z.boolean().optional(),
          })
          .strict(),
      )
      .output(settingsView)
      .mutation(({ ctx, input }) => wrapReceipt(async () => settings().set(await callerOf(ctx), input))),
  });
  const payments = router({
    receipt: router({
      preview: read
        .input(z.object({ paymentId: z.string().uuid() }).strict())
        .output(previewView)
        .query(({ ctx, input }) => wrapReceipt(async () => receipts().preview(await callerOf(ctx), input.paymentId))),
      send: write
        .input(
          z
            .object({
              paymentId: z.string().uuid(),
              kind: z.enum(RECEIPT_KINDS),
              address: z.string(),
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => wrapReceipt(async () => receipts().send(await callerOf(ctx), input))),
    }),
  });
  return { customerEmails, payments };
}

/** Both doors, for a caller that mounts this router by itself. */
export function createCustomerEmailRouter(deps: { readonly sql?: Sql }) {
  const { customerEmails, payments } = customerEmailParts(deps);
  return router({ merchant: router({ customerEmails }), payments });
}

/** What `mergeRouters` sees. No `merchant` key. */
export function createCustomerEmailNamespaceRouter(deps: { readonly sql?: Sql }) {
  return router({ payments: customerEmailParts(deps).payments });
}

/** `merchant.customerEmails`, spread into the portal merchant router. */
export function createMerchantCustomerEmails(deps: { readonly sql?: Sql }) {
  return customerEmailParts(deps).customerEmails;
}

export type CustomerEmailRouter = ReturnType<typeof createCustomerEmailRouter>;

async function wrapReceipt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await wrapOps(fn);
  } catch (error) {
    if (error instanceof ReceiptNotConnected) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'vendor.email', cause: error });
    }
    throw error;
  }
}
