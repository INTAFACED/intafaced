import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createAnalyticsRouter(c: BankRouterContext) {
  const { bank } = c;
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
  });
}
