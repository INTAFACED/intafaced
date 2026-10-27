import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { ONRAMP_METHODS } from './customer-ports.js';

/**
 * `bank.addMoney.methods/start/requests` (BK-xfer-04, BK-xfer-05, J-bank-02). The ways to pay in with their quotes, and the
 * customer's add-money requests, kept whether the rail opens them or refuses them. Nothing here posts to the ledger
 * (`./add-money.ts`).
 */

const amount = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,18})?$/)
  .refine((value) => /[1-9]/.test(value), 'The amount must be above zero');
const assetId = z.string().trim().min(1).max(16);
const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/);
const rail = z.enum(['rail.bank', 'rail.card']);

const quote = z.object({
  quoteId: z.string(),
  assetId: z.string(),
  amount: z.string(),
  method: z.enum(ONRAMP_METHODS),
  country: z.string(),
  payAmount: z.string(),
  fee: z.string(),
  rate: z.string(),
  payCurrency: z.string(),
  expiresAt: z.string(),
  deliveryEstimate: z.string().nullable(),
  simulated: z.literal(true),
});

const onramp = z.object({
  onrampId: z.string(),
  quoteId: z.string(),
  method: z.enum(ONRAMP_METHODS),
  payAmount: z.string(),
  fee: z.string(),
  payCurrency: z.string(),
  status: z.literal('pending_payment'),
  partnerRail: z.string(),
  hostedUrl: z.string().nullable(),
  bankInstructions: z.object({ reference: z.string(), accountName: z.string(), accountRef: z.string() }).nullable(),
});

const request = z.object({
  requestId: z.string(),
  assetId: z.string(),
  amount: z.string(),
  method: z.enum(ONRAMP_METHODS),
  country: z.string(),
  rail,
  status: z.enum(['opening', 'refused', 'opened']),
  refusalCode: z.string().nullable(),
  onramp: onramp.nullable(),
  createdAt: z.string(),
});

export function createAddMoneyRouter(bank: Pick<BankServices, 'addMoney'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    /** Every way to pay in, each with its quote or the reason there is none (`blocker`, with the rail it needs). */
    methods: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ assetId, amount, country }).strict())
      .output(
        z.object({
          methods: z.array(
            z.object({
              method: z.enum(ONRAMP_METHODS),
              rail,
              quote: quote.nullable(),
              blocker: z.string().nullable(),
              standIn: z.string().nullable(),
            }),
          ),
        }),
      )
      .query(({ ctx, input }) => guard(async () => ({ methods: await bank.addMoney.methods(ctx.principal.userId, input) }))),

    /** Ask for money to be added. The request id is the business key: the same id and terms is the same request. */
    start: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            requestId: z.string().guid(),
            assetId,
            amount,
            method: z.enum(ONRAMP_METHODS),
            country,
            quoteId: z.string().guid().optional(),
          })
          .strict(),
      )
      .output(request)
      .mutation(({ ctx, input }) => guard(async () => bank.addMoney.start(ctx.principal.userId, input))),

    /** The customer's own requests, newest first, for the tracker. */
    requests: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: z.number().int().min(1).max(50) }).strict())
      .output(z.array(request))
      .query(({ ctx, input }) => guard(async () => bank.addMoney.list(ctx.principal.userId, input.limit))),
  });
}
