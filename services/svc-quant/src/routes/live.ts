import {
  QUANT_LIVE_DEPLOY_UNAVAILABLE,
  QUANT_LIVE_DISABLED,
  QUANT_LIVE_ORDER_TYPE_UNSUPPORTED,
  QUANT_LIVE_PLAN_UNSUPPORTED,
  QuantError,
} from '../errors.js';
import {
  publicJurisdictionProcedure,
  quantLiveCheckInputSchema,
  quantLiveCheckSchema,
  quantLiveDeployInputSchema,
  router,
} from '@intafaced/contracts';
import { withQuantSpan } from '../tracing.js';
import { z } from 'zod';
import { toTrpc, accountField, type QuantCore } from './core.js';

export function liveRoutes(core: QuantCore) {
  const { liveCheckOf, accountOf } = core;
  return router({
    /** The deploy wizard's compile check of one version: what it would place live and whether it can. Writes nothing. */
    check: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantLiveCheckInputSchema.extend(accountField))
      .output(quantLiveCheckSchema)
      .query(async ({ input, ctx }) => {
        try {
          return await liveCheckOf(accountOf(ctx, input.accountId), input.strategyId, input.strategyVersion);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * Deploy (AL-live-02; J-algo-dev-06 #7). With the platform's live switch off it refuses `quant.live_disabled` and
     * nothing is written: no deploy intent, no run, nothing asked of the wallet. A version the runner can't trade
     * refuses with the compile check's code. With live on and a version that compiles, the funding move and the live
     * run after it are absent from this service (J-algo-dev-06 #8 builds them), so it refuses `quant.live_deploy_unavailable`
     * and still writes nothing. No money moves on any path.
     */
    deploy: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantLiveDeployInputSchema.extend(accountField))
      .output(z.never())
      .mutation(async ({ input, ctx }) =>
        withQuantSpan('quant.live.deploy', { language: 'none' }, async () => {
          try {
            const check = await liveCheckOf(accountOf(ctx, input.accountId), input.strategyId, input.strategyVersion);
            if (!check.liveEnabled) {
              throw new QuantError(
                QUANT_LIVE_DISABLED,
                'live trading for strategies is switched off on INTAFACED; nothing was deployed and nothing was stored',
              );
            }
            const refused = check.orderTypes.find((row) => !row.supported);
            if (refused) {
              throw new QuantError(
                refused.code === 'quant.live_plan_unsupported' ? QUANT_LIVE_PLAN_UNSUPPORTED : QUANT_LIVE_ORDER_TYPE_UNSUPPORTED,
                `${refused.source} — a live deploy can't place it; nothing was stored`,
              );
            }
            throw new QuantError(
              QUANT_LIVE_DEPLOY_UNAVAILABLE,
              'this build makes no funding move and starts no live run; nothing was stored',
            );
          } catch (err) {
            toTrpc(err);
          }
        }),
      ),
  });
}
