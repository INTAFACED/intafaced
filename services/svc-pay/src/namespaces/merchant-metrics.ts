import type { MerchantPartnerTerms } from '@intafaced/contracts';
import { router } from '@intafaced/contracts/trpc';
import { metricsToTrpcError, type MetricsRuntime } from '../metrics/index.js';
import { toPayfacTrpcError } from './metrics-errors.js';
import { notBuilt } from './errors.js';
import {
  PAY_MERCHANT_METRICS_SNAPSHOT,
  PAY_MERCHANT_METRICS_SERIES,
  PAY_MERCHANT_METRICS_PARTNER_TERMS,
  PAY_MERCHANT_METRICS_SETTLEMENT_ASSETS,
} from '@intafaced/contracts/pay-merchant-metrics-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { payRefusal } from '../record-refusal.js';

/**
 * `merchantMetrics.*` - a merchant's own read model (W2). Global metrics are `founderAdmin.*`.
 *
 * Both procedures authorise the caller for the REQUESTED merchant before any figure is read: the
 * caller's own merchant, or (PayFac) a sub-merchant over which it holds the `payment` and
 * `settlement` areas. An id that does not exist and an id the caller may not see are the same
 * answer (M1). Without a runtime the procedures refuse `pay.not_built`, as they did in W0.
 */
export function createMerchantMetricsRouter(
  metrics?: MetricsRuntime,
  /** The acquiring partner's terms for one business (`partner-terms.ts`). Absent: `partnerTerms` refuses `pay.not_built`. */
  partnerTerms?: (merchantId: string) => MerchantPartnerTerms,
) {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toPayfacTrpcError(metricsToTrpcError(err));
    }
  };
  return router({
    merchantMetrics: router({
      snapshot: mountRecord(
        PAY_MERCHANT_METRICS_SNAPSHOT,
        ({ ctx, input }) =>
          metrics
            ? wrap(async () => {
                await metrics.authority.assertCanRead(ctx.principal?.userId, input.merchantId);
                return metrics.reader.merchantSnapshot(input.merchantId, input.window);
              })
            : notBuilt('merchantMetrics.snapshot'),
        payRefusal,
      ),
      series: mountRecord(
        PAY_MERCHANT_METRICS_SERIES,
        ({ ctx, input }) =>
          metrics
            ? wrap(async () => {
                await metrics.authority.assertCanRead(ctx.principal?.userId, input.merchantId);
                return metrics.reader.merchantSeries(input);
              })
            : notBuilt('merchantMetrics.series'),
        payRefusal,
      ),
      /** Each asset the business can settle in, with its ledger figures; refuses `pay.settlement_assets_unset` when no list is set. */
      settlementAssets: mountRecord(
        PAY_MERCHANT_METRICS_SETTLEMENT_ASSETS,
        ({ ctx, input }) =>
          metrics
            ? wrap(async () => {
                await metrics.authority.assertCanRead(ctx.principal?.userId, input.merchantId);
                return metrics.reader.merchantSettlementAssets(input.merchantId);
              })
            : notBuilt('merchantMetrics.settlementAssets'),
        payRefusal,
      ),
      /**
       * The acquiring partner's terms for this business: reserve rule, who covers a chargeback shortfall, the currencies
       * it offers and its instant payout. A term the partner has not given is `{ known: false }`, never a zero.
       */
      partnerTerms: mountRecord(
        PAY_MERCHANT_METRICS_PARTNER_TERMS,
        ({ ctx, input }) =>
          metrics && partnerTerms
            ? wrap(async () => {
                await metrics.authority.assertCanRead(ctx.principal?.userId, input.merchantId);
                return partnerTerms(input.merchantId);
              })
            : notBuilt('merchantMetrics.partnerTerms'),
        payRefusal,
      ),
    }),
  });
}
