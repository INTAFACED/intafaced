import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { BANK_RAILS } from './rail-sends.js';

/**
 * `bank.railSends.requirements/check/send/list` (BK-xfer-02, J-bank-04 #1): send from a space to a bank account over a bank
 * rail (`./rail-sends.ts`). Asking takes `trade:withdraw`, the step-up scope, as every money-out door does. Nothing here
 * posts: with no banking partner on the rail, the intent is kept refused with `rail.bank`.
 */

const rail = z.enum(BANK_RAILS);

const ask = {
  fromSpaceId: z.string().uuid(),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,18})?$/),
  rail,
  recipient: z.record(z.string().max(64), z.string().max(254)).refine((value) => Object.keys(value).length <= 8),
};

const field = z.object({ name: z.string(), required: z.boolean(), choices: z.array(z.string()).nullable() }).strict();

const intent = z
  .object({
    requestId: z.string(),
    fromSpaceId: z.string(),
    assetId: z.string(),
    amount: z.string(),
    rail,
    recipient: z.string(),
    status: z.literal('refused'),
    refusalCode: z.string(),
    createdAt: z.string(),
  })
  .strict();

export function createRailSendsRouter(bank: Pick<BankServices, 'railSends'>, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    /** Each rail's recipient form and who carries it: no one in this build, so each names `rail.bank`. */
    requirements: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z
          .object({
            rails: z.array(z.object({ rail, fields: z.array(field), partner: z.null(), blocker: z.literal('rail.bank') }).strict()),
          })
          .strict(),
      )
      .query(() => guard(async () => ({ rails: bank.railSends.requirements() }))),

    /** Every check a send makes, keeping nothing: asked before the person spends a code on the confirmation. */
    check: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object(ask).strict())
      .output(z.object({ assetId: z.string(), amount: z.string(), available: z.string() }).strict())
      .query(({ ctx, input }) => guard(async () => bank.railSends.check(ctx.principal.userId, input))),

    /** Ask to send, behind the step-up scope. The request id is the business key of one ask. */
    send: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(z.object({ requestId: z.string().uuid(), ...ask }).strict())
      .output(intent)
      .mutation(({ ctx, input }) => guard(async () => bank.railSends.send(ctx.principal.userId, input))),

    /** The customer's own sends over a bank rail, newest first. */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: z.number().int().min(1).max(50) }).strict())
      .output(z.array(intent))
      .query(({ ctx, input }) => guard(async () => bank.railSends.list(ctx.principal.userId, input.limit))),
  });
}
