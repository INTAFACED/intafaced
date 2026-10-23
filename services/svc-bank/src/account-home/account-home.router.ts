import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { accountTermsOutput } from './account-terms.js';
import { profileField, profileOutput, profileView } from './profile.js';

/**
 * `bank.accounts.features`, `bank.accounts.profile` and `bank.currencies.list/add/remove` (BK-acct-01). The terms are a read
 * of the owner's publication; the currency writes are labels over ledger accounts. Nothing here writes to the ledger.
 *
 * Each call takes the profile it is made for. A profile the caller does not hold refuses `bank.profile_not_held` before
 * anything is read or written; a held business refuses the personal-account parts (`./profile.ts`).
 */

const assetId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{2,16}$/);

const forProfile = z.object({ profile: profileField }).strict();

const currency = z.object({ assetId: z.string(), spaceId: z.string(), balance: z.string() });

export function createAccountsRouter(
  bank: Pick<BankServices, 'accountTerms' | 'profiles'>,
  guard: <T>(fn: () => Promise<T>) => Promise<T>,
) {
  return router({
    /** The published base-tier terms. Blank refuses `bank.account_terms_unset`; there are no built-in terms. */
    features: scopedProcedure('bank:read', { module: 'bank' })
      .input(forProfile.optional())
      .output(accountTermsOutput)
      .query(({ ctx, input }) =>
        guard(async () => {
          await bank.profiles.personalOnly(ctx.principal.userId, input?.profile);
          return bank.accountTerms();
        }),
      ),

    /** The profile the app is showing, proved held: Personal, or a business with its name and the caller's role in it. */
    profile: scopedProcedure('bank:read', { module: 'bank' })
      .input(forProfile)
      .output(profileOutput)
      .query(({ ctx, input }) => guard(async () => profileView(await bank.profiles.resolve(ctx.principal.userId, input.profile)))),
  });
}

export function createCurrenciesRouter(
  bank: Pick<BankServices, 'currencies' | 'profiles'>,
  guard: <T>(fn: () => Promise<T>) => Promise<T>,
) {
  return router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(forProfile.optional())
      .output(
        z.object({
          currencies: z.array(currency),
          addable: z.array(z.string()).nullable(),
          addableBlocker: z.literal('bank.account_currencies_unset').nullable(),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          await bank.profiles.personalOnly(ctx.principal.userId, input?.profile);
          return bank.currencies.list(ctx.principal.userId);
        }),
      ),

    /** Put a currency on the account. The same currency again is the same space. */
    add: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ assetId, profile: profileField }).strict())
      .output(currency)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          await bank.profiles.personalOnly(ctx.principal.userId, input.profile);
          return bank.currencies.add(ctx.principal.userId, input.assetId);
        }),
      ),

    /** Take a currency off the account. Refuses `bank.currency_in_use` while it holds anything. */
    remove: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ assetId, profile: profileField }).strict())
      .output(z.object({ assetId: z.string(), removed: z.literal(true) }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          await bank.profiles.personalOnly(ctx.principal.userId, input.profile);
          return bank.currencies.remove(ctx.principal.userId, input.assetId);
        }),
      ),
  });
}
