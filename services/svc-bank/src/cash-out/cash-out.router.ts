import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { LINKED_ACCOUNT_BLOCKERS, LINKED_ACCOUNT_STATES } from '../linked-accounts/linked-accounts.js';

/**
 * `bank.cashOut.quote/start/requests` (BK-ord-01, J-bank-03): cash out to one of the customer's linked bank accounts
 * (`./cash-out.ts`). Asking takes `trade:withdraw`, the step-up scope, as every money-out door does. Nothing here posts.
 */

const amount = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,18})?$/);
const ask = { assetId: z.string().trim().min(1).max(16), amount, linkedAccountId: z.string().uuid() };

const account = z
  .object({
    accountId: z.string().uuid(),
    label: z.string(),
    holderName: z.string(),
    ibanMasked: z.string(),
    country: z.string(),
    state: z.enum(LINKED_ACCOUNT_STATES),
    usable: z.boolean(),
    blocker: z.enum(LINKED_ACCOUNT_BLOCKERS).nullable(),
    verificationRail: z.literal('rail.bank').nullable(),
    linkedAt: z.string(),
    coolingOffEndsAt: z.string().nullable(),
  })
  .strict();

const request = z
  .object({
    requestId: z.string(),
    assetId: z.string(),
    amount: z.string(),
    linkedAccountId: z.string(),
    rail: z.literal('rail.bank'),
    status: z.literal('refused'),
    refusalCode: z.string(),
    createdAt: z.string(),
  })
  .strict();

export function createCashOutRouter(bank: Pick<BankServices, 'cashOut'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    /** The entry checks, the account and what stands in the way. No fee or receive amount is invented. */
    quote: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object(ask).strict())
      .output(
        z
          .object({
            assetId: z.string(),
            amount: z.string(),
            available: z.string(),
            account,
            rail: z.literal('rail.bank'),
            fee: z.string().nullable(),
            receiveAmount: z.string().nullable(),
            blocker: z.string(),
          })
          .strict(),
      )
      .query(({ ctx, input }) => guard(async () => bank.cashOut.quote(ctx.principal.userId, input))),

    /** Ask to cash out, behind the step-up scope. The request id is the business key of one ask. */
    start: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(z.object({ requestId: z.string().uuid(), ...ask }).strict())
      .output(request)
      .mutation(({ ctx, input }) => guard(async () => bank.cashOut.start(ctx.principal.userId, input))),

    /** The customer's own cash-out requests, newest first. */
    requests: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: z.number().int().min(1).max(50) }).strict())
      .output(z.array(request))
      .query(({ ctx, input }) => guard(async () => bank.cashOut.list(ctx.principal.userId, input.limit))),
  });
}
