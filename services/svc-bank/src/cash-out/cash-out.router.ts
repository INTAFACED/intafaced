import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { LINKED_ACCOUNT_BLOCKERS, LINKED_ACCOUNT_STATES } from '../linked-accounts/linked-accounts.js';
import { CASH_OUT_STATUSES } from './cash-out.js';

/**
 * `bank.cashOut.quote/start/requests` (BK-ord-01, J-bank-03): cash out to one of the customer's linked bank accounts
 * (`./cash-out.ts`). Asking takes `trade:withdraw`, the step-up scope, as every money-out door does. Only a request the
 * banking partner can take is held; the partner's answers come through its signed job doors, never through this router.
 */

const amount = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,18})?$/);
const ask = { assetId: z.string().trim().min(1).max(16), amount, linkedAccountId: z.string().guid() };

const account = z
  .object({
    accountId: z.string().guid(),
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
    status: z.enum(CASH_OUT_STATUSES),
    refusalCode: z.string().nullable(),
    fee: z.string().nullable(),
    receiveAmount: z.string().nullable(),
    receiveCurrency: z.string().nullable(),
    payoutRef: z.string().nullable(),
    ledgerTxId: z.string().nullable(),
    failureCode: z.string().nullable(),
    returnedAmount: z.string().nullable(),
    remainsPaidOut: z.string().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
    failedAt: z.string().nullable(),
    returnedAt: z.string().nullable(),
  })
  .strict();

export function createCashOutRouter(bank: Pick<BankServices, 'cashOut'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    /** The entry checks, the account and what stands in the way, or the partner's fee and what arrives. None is invented. */
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
            receiveCurrency: z.string().nullable(),
            blocker: z.string().nullable(),
            standIn: z.string().nullable(),
          })
          .strict(),
      )
      .query(({ ctx, input }) => guard(async () => bank.cashOut.quote(ctx.principal.userId, input))),

    /** Ask to cash out, behind the step-up scope. The request id is the business key of one ask. */
    start: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(z.object({ requestId: z.string().guid(), ...ask }).strict())
      .output(request)
      .mutation(({ ctx, input }) => guard(async () => bank.cashOut.start(ctx.principal.userId, input))),

    /** The customer's own cash-out requests, newest first. */
    requests: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: z.number().int().min(1).max(50) }).strict())
      .output(z.array(request))
      .query(({ ctx, input }) => guard(async () => bank.cashOut.list(ctx.principal.userId, input.limit))),

    /** The signed receipt of a cash-out that was paid out: its text, SHA-256, signature and ledger transaction id. */
    receipt: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ requestId: z.string().guid() }).strict())
      .output(
        z.object({ fileName: z.string(), text: z.string(), ledgerTxId: z.string(), sha256: z.string(), signature: z.string() }).strict(),
      )
      .query(({ ctx, input }) => guard(async () => bank.cashOut.receipt(ctx.principal.userId, input.requestId))),
  });
}
