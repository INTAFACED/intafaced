import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { BANK_RAILS } from './rail-sends.js';

/**
 * `bank.railSends.*` (BK-xfer-02 and BK-xfer-06, J-bank-04 #1 and #2): send from a space to a bank account over a bank
 * rail (`./rail-sends.ts`). Asking takes `trade:withdraw`, the step-up scope, as every money-out door does. Nothing here
 * posts: with no banking partner on the rail, the intent is kept refused with `rail.bank`.
 */

const rail = z.enum(BANK_RAILS);

const recipient = z.record(z.string().max(64), z.string().max(254)).refine((value) => Object.keys(value).length <= 8);
const from = {
  fromSpaceId: z.string().uuid(),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,18})?$/),
};
/** Details typed for this send, or a saved recipient. */
const typed = { ...from, rail, recipient };
const saved = { ...from, payeeId: z.string().uuid() };
const ask = z.union([z.object(typed).strict(), z.object(saved).strict()]);
const requestId = z.string().uuid();

const payeeAsk = z.object({ nickname: z.string().max(120), country: z.string().max(8), rail, recipient }).strict();

const payee = z
  .object({
    payeeId: z.string(),
    nickname: z.string(),
    country: z.string(),
    rail,
    recipient: z.string(),
    verification: z.literal('cannot_check'),
    verificationRail: z.literal('rail.bank'),
    addedAt: z.string(),
    cooling: z.object({ state: z.enum(['unset', 'active', 'open']), endsAt: z.string().nullable() }).strict(),
  })
  .strict();

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

export function createRailSendsRouter(
  bank: Pick<BankServices, 'railSends' | 'railPayees'>,
  guard: <T>(fn: () => Promise<T>) => Promise<T>,
) {
  return router({
    /**
     * Each rail's recipient form and who carries it (no one in this build, so each names `rail.bank`), and the countries
     * the recipient book takes with the rails each one's forms come from.
     */
    requirements: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z
          .object({
            rails: z.array(z.object({ rail, fields: z.array(field), partner: z.null(), blocker: z.literal('rail.bank') }).strict()),
            countries: z.array(z.object({ country: z.string(), rails: z.array(rail) }).strict()),
          })
          .strict(),
      )
      .query(() => guard(async () => ({ rails: bank.railSends.requirements(), countries: bank.railPayees.countries() }))),

    /** Every check a send makes, keeping nothing: asked before the person spends a code on the confirmation. */
    check: scopedProcedure('bank:read', { module: 'bank' })
      .input(ask)
      .output(z.object({ assetId: z.string(), amount: z.string(), available: z.string() }).strict())
      .query(({ ctx, input }) => guard(async () => bank.railSends.check(ctx.principal.userId, input))),

    /** Ask to send, behind the step-up scope. The request id is the business key of one ask. */
    send: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(z.union([z.object({ requestId, ...typed }).strict(), z.object({ requestId, ...saved }).strict()]))
      .output(intent)
      .mutation(({ ctx, input }) => guard(async () => bank.railSends.send(ctx.principal.userId, input))),

    /** The customer's own sends over a bank rail, newest first. */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: z.number().int().min(1).max(50) }).strict())
      .output(z.array(intent))
      .query(({ ctx, input }) => guard(async () => bank.railSends.list(ctx.principal.userId, input.limit))),

    /** The recipient book (BK-xfer-06): saved recipients with their name check and cooling-off, newest first. */
    payees: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: z.number().int().min(1).max(50) }).strict())
      .output(z.array(payee))
      .query(({ ctx, input }) => guard(async () => bank.railPayees.list(ctx.principal.userId, input.limit))),

    /** Every check saving makes, keeping nothing: asked before the person spends a code on the confirmation. */
    checkPayee: scopedProcedure('bank:read', { module: 'bank' })
      .input(payeeAsk)
      .output(z.object({ nickname: z.string(), country: z.string(), rail, recipient: z.string() }).strict())
      .query(({ input }) => guard(async () => bank.railPayees.check(input))),

    /** Save a recipient, behind the step-up scope: the same destination again is the same recipient. */
    addPayee: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(payeeAsk)
      .output(payee)
      .mutation(({ ctx, input }) => guard(async () => bank.railPayees.add(ctx.principal.userId, input))),

    /** Remove a saved recipient, waiting or not. */
    removePayee: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ payeeId: z.string().uuid() }).strict())
      .output(z.object({ payeeId: z.string(), removed: z.literal(true) }).strict())
      .mutation(({ ctx, input }) => guard(async () => bank.railPayees.remove(ctx.principal.userId, input.payeeId))),

    /** Invite a recipient to enter their own details by email: refused by name while no email delivery is connected. */
    invitePayee: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ email: z.string().max(254) }).strict())
      .output(z.never())
      .mutation(({ input }) => guard(async () => bank.railPayees.invite(input.email))),
  });
}
