import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import type { ReceivedHoldView } from './received-holds.js';

/**
 * `bank.holds.*` (PP-money-balance-05, J-pay-03 #5): how the caller treats payments from people not in their contacts,
 * and the payments held for them. Reading is `bank:read`; the rule, Accept and Deny are `bank:write`. Every answer is the
 * caller's own: a hold of anyone else's reads the same not-found as a missing id.
 */

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

const ruleView = z.object({
  strangers: z.enum(['pay_in', 'hold']),
  /** Whole days a held payment waits for an answer; null while the owner has published none. */
  holdDays: z.number().int().min(1).max(365).nullable(),
});

const holdView = z.object({
  transferId: z.string(),
  state: z.enum(['placing', 'held', 'releasing', 'released', 'returning', 'returned', 'lapsed']),
  reasonClass: z.literal('stranger'),
  amount: amountString,
  assetId: z.string(),
  fromHandle: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  releaseAt: z.string(),
  decidedAt: z.string().nullable(),
});

const viewOf = (hold: ReceivedHoldView) => ({ ...hold });

const transferIdInput = z.object({ transferId: z.string().min(8).max(64) }).strict();

export function createHoldsRouter(bank: BankServices, guard: Guard) {
  return router({
    /** The caller's rule for payments from people not in their contacts, and the owner's release period. */
    rule: scopedProcedure('bank:read', { module: 'bank' })
      .output(ruleView)
      .query(({ ctx }) => guard(() => bank.receivedHolds.rule(ctx.principal.userId))),

    /** Set the rule. "hold" while no release period is published refuses `bank.stranger_hold_period_unset`. */
    setRule: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ strangers: z.enum(['pay_in', 'hold']) }).strict())
      .output(ruleView)
      .mutation(({ ctx, input }) => guard(() => bank.receivedHolds.setRule(ctx.principal.userId, input.strangers))),

    /** The caller's payments waiting for an answer, newest first. */
    waiting: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.array(holdView))
      .query(({ ctx }) => guard(async () => (await bank.receivedHolds.waiting(ctx.principal.userId)).map(viewOf))),

    /** Accept: the whole held payment goes into the caller's balance, once. */
    accept: scopedProcedure('bank:write', { module: 'bank' })
      .input(transferIdInput)
      .output(holdView)
      .mutation(({ ctx, input }) =>
        guard(async () => viewOf(await bank.receivedHolds.decideHold(ctx.principal.userId, input.transferId, 'release'))),
      ),

    /** Deny: the whole held payment goes back to the person who sent it, once. */
    deny: scopedProcedure('bank:write', { module: 'bank' })
      .input(transferIdInput)
      .output(holdView)
      .mutation(({ ctx, input }) =>
        guard(async () => viewOf(await bank.receivedHolds.decideHold(ctx.principal.userId, input.transferId, 'return'))),
      ),
  });
}
