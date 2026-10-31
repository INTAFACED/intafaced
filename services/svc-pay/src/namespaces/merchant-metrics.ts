import {
  router,
  merchantMetricsInputSchema,
  merchantMetricsSnapshotSchema,
  merchantMetricsSeriesInputSchema,
  merchantMetricsSeriesSchema,
  merchantSettlementAssetsInputSchema,
  merchantSettlementAssetsSchema,
} from '@intafaced/contracts';
import { metricsToTrpcError, type MetricsRuntime } from '../metrics/index.js';
import { toPayfacTrpcError } from './metrics-errors.js';
import { notBuilt } from './errors.js';
import { ownMerchantRead } from '../own-merchant-read.js';

/**
 * `merchantMetrics.*` - a merchant's own read model (W2). Global metrics are `founderAdmin.*`.
 *
 * Both procedures authorise the caller for the REQUESTED merchant before any figure is read: the
 * caller's own merchant, or (PayFac) a sub-merchant over which it holds the `payment` and
 * `settlement` areas. An id that does not exist and an id the caller may not see are the same
 * answer (M1). Without a runtime the procedures refuse `pay.not_built`, as they did in W0.
 */
export function createMerchantMetricsRouter(metrics?: MetricsRuntime) {
  const read = ownMerchantRead();
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toPayfacTrpcError(metricsToTrpcError(err));
    }
  };
  return router({
    merchantMetrics: router({
      snapshot: read
        .input(merchantMetricsInputSchema)
        .output(merchantMetricsSnapshotSchema)
        .query(({ ctx, input }) =>
          metrics
            ? wrap(async () => {
                await metrics.authority.assertCanRead(ctx.principal?.userId, input.merchantId);
                return metrics.reader.merchantSnapshot(input.merchantId, input.window);
              })
            : notBuilt('merchantMetrics.snapshot'),
        ),
      series: read
        .input(merchantMetricsSeriesInputSchema)
        .output(merchantMetricsSeriesSchema)
        .query(({ ctx, input }) =>
          metrics
            ? wrap(async () => {
                await metrics.authority.assertCanRead(ctx.principal?.userId, input.merchantId);
                return metrics.reader.merchantSeries(input);
              })
            : notBuilt('merchantMetrics.series'),
        ),
      /** Each asset the business can settle in, with its ledger figures; refuses `pay.settlement_assets_unset` when no list is set. */
      settlementAssets: read
        .input(merchantSettlementAssetsInputSchema)
        .output(merchantSettlementAssetsSchema)
        .query(({ ctx, input }) =>
          metrics
            ? wrap(async () => {
                await metrics.authority.assertCanRead(ctx.principal?.userId, input.merchantId);
                return metrics.reader.merchantSettlementAssets(input.merchantId);
              })
            : notBuilt('merchantMetrics.settlementAssets'),
        ),
    }),
  });
}
