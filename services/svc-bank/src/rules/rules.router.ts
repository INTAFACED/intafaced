import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { REMINDER_LEAD_HOURS, RULE_TERMS_UNSET } from './scheduled-notices.js';

/**
 * `bank.rules.*` (BK-acct-10, J-bank-06 #6): the person's payment reminder rule and the rules that would move money by
 * themselves. Reading is `bank:read`; saving the reminder rule and asking for a money rule are `bank:write`. A money rule
 * refuses `bank.rule_terms_unset` until the owner publishes its terms, and nothing is stored.
 */

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);
const leadHours = z.literal(REMINDER_LEAD_HOURS);

const reminderView = z.object({
  ruleKey: z.string(),
  leadHours: leadHours.nullable(),
  revision: z.number().int(),
  updatedAt: z.string(),
});

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function createRulesRouter(bank: BankServices, guard: Guard) {
  return router({
    get: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          reminder: reminderView.nullable(),
          leadChoices: z.array(z.number().int()),
          moneyRules: z.object({ state: z.literal('not_set'), code: z.literal(RULE_TERMS_UNSET) }),
        }),
      )
      .query(({ ctx }) =>
        guard(async () => ({
          reminder: await bank.scheduledNotices.reminderRule(ctx.principal.userId),
          leadChoices: [...REMINDER_LEAD_HOURS],
          moneyRules: { state: 'not_set' as const, code: RULE_TERMS_UNSET },
        })),
      ),

    /** Save the reminder rule: a lead time from the offered choices, or `null` for off, at the revision read (0 for none). */
    setReminder: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            leadHours: leadHours.nullable(),
            expectedRevision: z.number().int().min(0),
            clientRequestId: z.string().min(1).max(128),
          })
          .strict(),
      )
      .output(reminderView)
      .mutation(({ ctx, input }) => guard(() => bank.scheduledNotices.setReminderRule({ userId: ctx.principal.userId, ...input }))),

    /**
     * A rule that moves money by itself, by date or by balance, between the person's own spaces. Refused
     * `bank.rule_terms_unset` while the owner has published no terms for such rules; nothing is stored.
     */
    createMoneyRule: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            name: z.string().trim().min(1).max(60),
            fromSpaceId: z.string().uuid(),
            toSpaceId: z.string().uuid(),
            trigger: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('date'), cadence: z.enum(['daily', 'weekly', 'monthly']) }).strict(),
              z.object({ kind: z.literal('balance'), above: amountString }).strict(),
            ]),
            amount: amountString,
            clientRequestId: z.string().min(1).max(128),
          })
          .strict(),
      )
      .output(z.never())
      .mutation(() => guard(async () => bank.scheduledNotices.createMoneyRule())),
  });
}
