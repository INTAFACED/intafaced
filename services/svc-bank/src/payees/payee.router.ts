import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { throwBankProcedure } from '../bank-procedure.js';

/**
 * `bank.payees` — recipients this customer saved on the server.
 * List is a read. Add and remove are writes and each carries a command id,
 * so a lost reply and a retry are the same save.
 */

const commandId = z.string().min(8).max(64);
const userId = z.string().uuid();
const nickname = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((value) => !/[\u0000-\u001F]/.test(value), 'nickname has a control character');

const payee = z.object({
  userId: z.string().uuid(),
  nickname: z.string().nullable(),
  addedAt: z.string().datetime(),
  handle: z.string().nullable(),
});

export function createPayeesRouter(bank: Pick<BankServices, 'payees'>) {
  return router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ payees: z.array(payee) }))
      .query(async ({ ctx }) => {
        try {
          return { payees: await bank.payees.list(ctx.principal.userId) };
        } catch (err) {
          throwBankProcedure(err);
        }
      }),

    add: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ commandId, userId, nickname: nickname.optional() }).strict())
      .output(payee)
      .mutation(async ({ ctx, input }) => {
        try {
          return await bank.payees.add(ctx.principal.userId, {
            commandId: input.commandId,
            userId: input.userId,
            nickname: input.nickname ?? null,
          });
        } catch (err) {
          throwBankProcedure(err);
        }
      }),

    remove: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ commandId, userId }).strict())
      .output(z.object({ removed: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await bank.payees.remove(ctx.principal.userId, input);
        } catch (err) {
          throwBankProcedure(err);
        }
      }),
  });
}
