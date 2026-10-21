import { z } from 'zod';
import { router, publicProcedure, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { ACCOUNT_DETAIL_REQUEST_STATES } from './account-details.js';

/**
 * `bank.accountDetails.list/get/request` and `bank.eligibility.get` (BK-acct-03). Reads, and one request that the banking partner
 * (not wired today: `rail.bank`) answers. Nothing here writes to the ledger.
 */

const currencyCode = z.string().trim().min(3).max(3);

const detailSet = z.object({
  id: z.string(),
  accountNumber: z.string().nullable(),
  sortCode: z.string().nullable(),
  routingNumber: z.string().nullable(),
  bsb: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  partnerBank: z.string(),
  restrictions: z.array(z.string()),
});

const currencyDetails = z.object({
  currency: z.string(),
  state: z.enum(['unavailable', ...ACCOUNT_DETAIL_REQUEST_STATES]),
  blocker: z.literal('rail.bank').nullable(),
  sets: z.array(detailSet),
});

export function createAccountDetailsRouter(bank: Pick<BankServices, 'accountDetails'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ currencies: z.array(currencyDetails) }))
      .query(({ ctx }) => guard(async () => bank.accountDetails.list(ctx.principal.userId))),

    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ currency: currencyCode }).strict())
      .output(currencyDetails)
      .query(({ ctx, input }) => guard(async () => bank.accountDetails.get(ctx.principal.userId, input.currency))),

    /** Ask for details in one currency. The same customer and currency again is the same request. */
    request: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ currency: currencyCode }).strict())
      .output(currencyDetails)
      .mutation(({ ctx, input }) => guard(async () => bank.accountDetails.request(ctx.principal.userId, input.currency))),
  });
}

export function createEligibilityRouter(bank: Pick<BankServices, 'accountDetails'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    /** Public: who can open an account is readable before sign-up. A region adds the platform's own verdict for it. */
    get: publicProcedure
      .input(
        z
          .object({
            region: z
              .string()
              .trim()
              .regex(/^[A-Za-z]{2}$/)
              .optional(),
          })
          .strict()
          .optional(),
      )
      .output(
        z.object({
          rules: z.object({
            countries: z.array(z.string()),
            entityTypes: z.array(z.string()),
            productRestrictions: z.array(z.object({ product: z.string(), restriction: z.string() })),
          }),
          verdict: z
            .object({
              region: z.string(),
              status: z.enum(['open', 'restricted', 'blocked']),
              minTier: z.string(),
              notes: z.string().nullable(),
              source: z.literal('JURISDICTION_MATRIX'),
              listed: z.boolean(),
            })
            .nullable(),
        }),
      )
      .query(({ input }) => guard(async () => bank.accountDetails.eligibility(input?.region))),
  });
}
