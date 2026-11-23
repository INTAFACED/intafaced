import { toTrpc, type QuantCore, quantRefusal } from './core.js';
import { QUANT_QUICK_START } from '@intafaced/contracts/quant-quick-start-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';

export function quickStartRoutes(core: QuantCore) {
  const { strategies, runs, accountOf } = core;
  return mountRecord(
    QUANT_QUICK_START,
    async ({ input, ctx }) => {
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
    },
    quantRefusal,
  );
}
