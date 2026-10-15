import {
  router,
  founderMerchantListInputSchema,
  founderMerchantListSchema,
  founderMerchantDrilldownInputSchema,
  founderMerchantDrilldownSchema,
  founderGlobalMetricsInputSchema,
  founderGlobalMetricsSchema,
  founderChangeSubmitInputSchema,
  founderChangeSubmitResultSchema,
  founderChangeConfirmInputSchema,
  founderApprovalQueueInputSchema,
  founderApprovalQueueSchema,
  founderTreasuryExposureSchema,
  merchantMetricsInputSchema,
  merchantMetricsSnapshotSchema,
  merchantMetricsSeriesInputSchema,
  merchantMetricsSeriesSchema,
} from '@intafaced/contracts';
import { z } from 'zod';
import type { FounderAuthority } from '../founder-authority.js';
import { metricsToTrpcError, type MetricsRuntime } from '../metrics/index.js';
import { notBuilt } from './errors.js';
import { founderProcedure } from './founder-procedure.js';

/**
 * `founderAdmin.*` — the global founder panel (W2 fills `merchants.list` and `metrics.*`; W4 the rest).
 *
 * EVERY procedure here MUST be built from `founderProcedure`. Do not use
 * `scopedProcedure('admin:read')`: that scope can sit on a long-lived API key.
 * The static inventory test (G7) fails the build if one is not.
 */
export function createFounderAdminRouter(founderAuthority: FounderAuthority, metrics?: MetricsRuntime) {
  const founder = founderProcedure(founderAuthority);
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw metricsToTrpcError(err);
    }
  };
  return router({
    founderAdmin: router({
      merchants: router({
        list: founder
          .input(founderMerchantListInputSchema)
          .output(founderMerchantListSchema)
          .query(({ input }) => (metrics ? wrap(() => metrics.reader.merchantList(input)) : notBuilt('founderAdmin.merchants.list'))),
        drilldown: founder
          .input(founderMerchantDrilldownInputSchema)
          .output(founderMerchantDrilldownSchema)
          .query(() => notBuilt('founderAdmin.merchants.drilldown')),
      }),
      metrics: router({
        global: founder
          .input(founderGlobalMetricsInputSchema)
          .output(founderGlobalMetricsSchema)
          .query(({ input }) =>
            metrics ? wrap(() => metrics.reader.globalMetrics(input.window)) : notBuilt('founderAdmin.metrics.global'),
          ),
        /** Any merchant's snapshot (the same figures the merchant sees). Founder authority replaces ownership. */
        merchant: founder
          .input(merchantMetricsInputSchema)
          .output(merchantMetricsSnapshotSchema)
          .query(({ input }) =>
            metrics
              ? wrap(() => metrics.reader.merchantSnapshot(input.merchantId, input.window))
              : notBuilt('founderAdmin.metrics.merchant'),
          ),
        merchantSeries: founder
          .input(merchantMetricsSeriesInputSchema)
          .output(merchantMetricsSeriesSchema)
          .query(({ input }) =>
            metrics ? wrap(() => metrics.reader.merchantSeries(input)) : notBuilt('founderAdmin.metrics.merchantSeries'),
          ),
      }),
      changes: router({
        submit: founder
          .input(founderChangeSubmitInputSchema)
          .output(founderChangeSubmitResultSchema)
          .mutation(() => notBuilt('founderAdmin.changes.submit')),
        confirm: founder
          .input(founderChangeConfirmInputSchema)
          .output(founderChangeSubmitResultSchema)
          .mutation(() => notBuilt('founderAdmin.changes.confirm')),
      }),
      approvals: router({
        list: founder
          .input(founderApprovalQueueInputSchema)
          .output(founderApprovalQueueSchema)
          .query(() => notBuilt('founderAdmin.approvals.list')),
      }),
      treasury: router({
        exposure: founder
          .input(z.object({}).strict())
          .output(founderTreasuryExposureSchema)
          .query(() => notBuilt('founderAdmin.treasury.exposure')),
      }),
    }),
  });
}
