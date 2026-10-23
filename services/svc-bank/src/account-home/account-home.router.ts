import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { accountTermsOutput } from './account-terms.js';

/**
 * `bank.accounts.features` and `bank.currencies.list/add/remove` (BK-acct-01). The terms are a read of the owner's
 * publication; the currency writes are labels over ledger accounts. Nothing here writes to the ledger.
 */

const assetId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{2,16}$/);

const currency = z.object({ assetId: z.string(), spaceId: z.string(), balance: z.string() });

export function createAccountsRouter(bank: Pick<BankServices, 'accountTerms'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    /** The published base-tier terms. Blank refuses `bank.account_terms_unset`; there are no built-in terms. */
    features: scopedProcedure('bank:read', { module: 'bank' })
      .output(accountTermsOutput)
      .query(() => guard(async () => bank.accountTerms())),
  });
}

export function createCurrenciesRouter(bank: Pick<BankServices, 'currencies'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          currencies: z.array(currency),
          addable: z.array(z.string()).nullable(),
          addableBlocker: z.literal('bank.account_currencies_unset').nullable(),
        }),
      )
      .query(({ ctx }) => guard(async () => bank.currencies.list(ctx.principal.userId))),

    /** Put a currency on the account. The same currency again is the same space. */
    add: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ assetId }).strict())
      .output(currency)
      .mutation(({ ctx, input }) => guard(async () => bank.currencies.add(ctx.principal.userId, input.assetId))),

    /** Take a currency off the account. Refuses `bank.currency_in_use` while it holds anything. */
    remove: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ assetId }).strict())
      .output(z.object({ assetId: z.string(), removed: z.literal(true) }))
      .mutation(({ ctx, input }) => guard(async () => bank.currencies.remove(ctx.principal.userId, input.assetId))),
  });
}
