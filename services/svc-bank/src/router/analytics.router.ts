import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { guard } from './errors.js';
import { amountString } from './shared.js';
import { BUDGET_CATEGORIES, type BudgetProgress } from '../analytics/budgets.js';
import type { BankRouterContext } from './context.js';

export function createAnalyticsRouter(c: BankRouterContext) {
  const { bank } = c;
  const budgetOutput = z.object({
    assetId: z.string(),
    category: z.enum(BUDGET_CATEGORIES as [string, ...string[]]),
    period: z.string(),
    target: z.string(),
    spent: z.string(),
    progressBps: z.number().int(),
    alertBps: z.number().int(),
    alert: z.enum(['new', 'seen']).nullable(),
    alertShownAt: z.string().nullable(),
  });
  const present = (b: BudgetProgress) => ({ ...b, alertShownAt: b.alertShownAt?.toISOString() ?? null });
  const assetInput = z.object({ assetId: z.string().min(1).max(16) });
  return router({
    spend: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          from: z.string().datetime({ offset: true }),
          to: z.string().datetime({ offset: true }),
        }),
      )
      .output(
        z.object({
          assetId: z.string(),
          from: z.string(),
          to: z.string(),
          outflowByCategory: z.record(z.string(), z.string()),
          totalOutflow: z.string(),
          totalInflow: z.string(),
          net: z.string(),
          movements: z.number().int(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const summary = await bank.analytics.spendSummary({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            range: { from: new Date(input.from), to: new Date(input.to) },
          });
          return {
            assetId: summary.assetId,
            from: summary.from,
            to: summary.to,
            outflowByCategory: summary.outflowByCategory,
            totalOutflow: summary.totalOutflow,
            totalInflow: summary.totalInflow,
            net: summary.net,
            movements: summary.movements,
          };
        }),
      ),

    /** BK-acct-08: the person's budgets in one asset, each with this month's spend folded from the ledger. */
    budgets: scopedProcedure('bank:read', { module: 'bank' })
      .input(assetInput)
      .output(z.array(budgetOutput))
      .query(({ ctx, input }) => guard(async () => (await bank.budgets.list(ctx.principal.userId, input.assetId)).map(present))),

    /** Sets or changes one category's monthly target and the alert share the person chose (basis points). */
    setBudget: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        assetInput.extend({
          category: z.enum(BUDGET_CATEGORIES as [string, ...string[]]),
          target: amountString,
          alertBps: z.number().int().min(1).max(10_000),
        }),
      )
      .output(budgetOutput)
      .mutation(({ ctx, input }) => guard(async () => present(await bank.budgets.set({ userId: ctx.principal.userId, ...input })))),

    /** Records that this month's alert for one budget was shown, so it shows once per month. */
    budgetAlertShown: scopedProcedure('bank:write', { module: 'bank' })
      .input(assetInput.extend({ category: z.enum(BUDGET_CATEGORIES as [string, ...string[]]) }))
      .output(budgetOutput)
      .mutation(({ ctx, input }) => guard(async () => present(await bank.budgets.alertShown({ userId: ctx.principal.userId, ...input })))),

    /** This month's budget targets less this month's spend. Refuses `bank.budget_unset` with no budget. */
    leftToSpend: scopedProcedure('bank:read', { module: 'bank' })
      .input(assetInput)
      .output(z.object({ assetId: z.string(), period: z.string(), target: z.string(), spent: z.string(), left: z.string() }))
      .query(({ ctx, input }) => guard(() => bank.budgets.leftToSpend(ctx.principal.userId, input.assetId))),

    /** Two to twelve months side by side by category, with each category's change; a month with no movement is zero. */
    compare: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        assetInput.extend({
          months: z
            .array(z.string().regex(/^\d{4}-\d{2}$/))
            .min(2)
            .max(12),
        }),
      )
      .output(
        z.object({
          assetId: z.string(),
          months: z.array(z.string()),
          categories: z.array(z.object({ category: z.string(), byMonth: z.array(z.string()), change: z.string() })),
          totalOutflow: z.array(z.string()),
          totalInflow: z.array(z.string()),
        }),
      )
      .query(({ ctx, input }) => guard(() => bank.budgets.compare(ctx.principal.userId, input.assetId, input.months))),
  });
}
