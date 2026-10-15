import {
  router,
  scopedProcedure,
  merchantMetricsInputSchema,
  merchantMetricsSnapshotSchema,
  merchantMetricsSeriesInputSchema,
  merchantMetricsSeriesSchema,
} from '@intafaced/contracts';
import { notBuilt } from './errors.js';

/** `merchantMetrics.*` — a merchant's own read model (W2 replaces these stubs). Global metrics are `founderAdmin.*`. */
export function createMerchantMetricsRouter() {
  const read = scopedProcedure('pay:read', { module: 'pay' });
  return router({
    merchantMetrics: router({
      snapshot: read
        .input(merchantMetricsInputSchema)
        .output(merchantMetricsSnapshotSchema)
        .query(() => notBuilt('merchantMetrics.snapshot')),
      series: read
        .input(merchantMetricsSeriesInputSchema)
        .output(merchantMetricsSeriesSchema)
        .query(() => notBuilt('merchantMetrics.series')),
    }),
  });
}
