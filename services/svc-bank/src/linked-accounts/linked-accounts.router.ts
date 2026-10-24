import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { LINKED_ACCOUNT_BLOCKERS, LINKED_ACCOUNT_STATES } from './linked-accounts.js';

/**
 * `bank.linkedAccounts.list/link/remove` (BK-acct-02, J-bank-02 #6): the customer's own accounts at other banks
 * (`./linked-accounts.ts`). Linking and removing take `trade:withdraw`, the step-up scope, as saving a withdrawal address
 * does: a leaked key or a stolen access token must not be able to add the account that money is later paid out to.
 */

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

export function createLinkedAccountsRouter(bank: Pick<BankServices, 'linkedAccounts'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    /** Every account the customer has linked, oldest first, each with its state and why it cannot be used yet. */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ accounts: z.array(account) }).strict())
      .query(({ ctx }) => guard(async () => ({ accounts: await bank.linkedAccounts.list(ctx.principal.userId) }))),

    /** Link an account, kept `unverified`. The IBAN is the business key: linking it again returns the same account. */
    link: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(
        z
          .object({
            label: z.string().min(1).max(64),
            holderName: z.string().min(1).max(140),
            iban: z.string().min(15).max(64),
          })
          .strict(),
      )
      .output(z.object({ account, created: z.boolean() }).strict())
      .mutation(({ ctx, input }) => guard(async () => bank.linkedAccounts.link(ctx.principal.userId, input))),

    /** Unlink, with the same step-up scope. Removing one already removed answers the same. */
    remove: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid() }).strict())
      .output(z.object({ accountId: z.string(), removed: z.literal(true) }).strict())
      .mutation(({ ctx, input }) => guard(async () => bank.linkedAccounts.remove(ctx.principal.userId, input.accountId))),
  });
}
