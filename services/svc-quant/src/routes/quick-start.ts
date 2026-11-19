import { publicJurisdictionProcedure, quantQuickStartOutputSchema } from '@intafaced/contracts';
import { z } from 'zod';
import { toTrpc, accountField, type QuantCore } from './core.js';

export function quickStartRoutes(core: QuantCore) {
  const { strategies, runs, accountOf } = core;
  return publicJurisdictionProcedure('quant', 'fiat')
    .input(z.object({ ...accountField }).optional())
    .output(quantQuickStartOutputSchema)
    .query(async ({ input, ctx }) => {
      try {
        const accountId = accountOf(ctx, input?.accountId);
        const [saved, ran] = await Promise.all([
          strategies.list({ accountId, limit: 1, cursor: null }),
          runs.okKinds({ userId: accountId }),
        ]);
        return { strategy: saved.strategies.length > 0, backtest: ran.backtest, paperRun: ran.sandbox };
      } catch (err) {
        toTrpc(err);
      }
    });
}
