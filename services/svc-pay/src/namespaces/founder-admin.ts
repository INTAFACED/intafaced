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
import type { Sql } from 'postgres';
import { metricsToTrpcError, type MetricsRuntime } from '../metrics/index.js';
import { createFounderOpsRouter, type FounderOpsRouter } from '../merchant-ops/router.js';
import { notBuilt } from './errors.js';
import { treasuryExposureView, type ConversionInventorySource } from '../treasury/exposure.js';
import type { TreasuryLimits } from '../treasury/config.js';
import type { ControlService } from '../control/service.js';
import { createFounderControlRouter, founderApprovalProcedures, founderChangeProcedures } from './founder-control.js';
import { founderProcedure } from './founder-procedure.js';
import { createRegistriesRouter, type RegistriesMountDeps } from '../registries/index.js';

/**
 * `founderAdmin.*` — the global founder panel (W2 fills `merchants.list` and `metrics.*`; W4 the rest).
 *
 * EVERY procedure here MUST be built from `founderProcedure`. Do not use
 * `scopedProcedure('admin:read')`: that scope can sit on a long-lived API key.
 * The static inventory test (G7) fails the build if one is not.
 */
/** W5: what `founderAdmin.treasury.exposure` reads. Absent = still a `pay.not_built` stub. */
export interface FounderTreasuryDeps {
  readonly sql: Sql;
  readonly limits: TreasuryLimits;
  readonly inventory: ConversionInventorySource;
}

/** Optional mounts for `founderAdmin`. Each workstream adds its own key here. */
export interface FounderAdminMounts {
  /** W2: metrics reader. Without it the metrics and merchant-list procedures refuse with `pay.not_built`. */
  metrics?: MetricsRuntime;
  /** W16: editable venue, network and wallet-route registries. Mounted only when supplied. */
  registries?: RegistriesMountDeps;
  /** W15: operator notes (`founderAdmin.ops.*`). Always mounted; without a supplied router it runs with no database and refuses with `pay.not_built`. */
  ops?: FounderOpsRouter;
  /** W5: treasury exposure read (`founderAdmin.treasury.exposure`). Without it the procedure refuses with `pay.not_built`. */
  treasury?: FounderTreasuryDeps;
  /** W1: merchant control room (`founderAdmin.control.*`, founder changes and payout approvals). Without it those procedures refuse with `pay.not_built`. */
  control?: ControlService;
}

export function createFounderAdminRouter(founderAuthority: FounderAuthority, mounts: FounderAdminMounts = {}) {
  const { metrics, registries, treasury, control } = mounts;
  const ops = mounts.ops ?? createFounderOpsRouter({ founderAuthority });
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
      // W16: editable venue, network and wallet-route registries (src/registries). Mounted only when its deps are supplied.
      ...(registries ? { registries: createRegistriesRouter({ founderAuthority, ...registries }) } : {}),
      // W15 operator notes. A router cannot be merged beside this one (tRPC rejects a second `founderAdmin`), so it is mounted here.
      ops,
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
      changes: router(
        control
          ? founderChangeProcedures(founder, control)
          : {
              submit: founder
                .input(founderChangeSubmitInputSchema)
                .output(founderChangeSubmitResultSchema)
                .mutation(() => notBuilt('founderAdmin.changes.submit')),
              confirm: founder
                .input(founderChangeConfirmInputSchema)
                .output(founderChangeSubmitResultSchema)
                .mutation(() => notBuilt('founderAdmin.changes.confirm')),
            },
      ),
      approvals: router(
        control
          ? founderApprovalProcedures(founder, control)
          : {
              list: founder
                .input(founderApprovalQueueInputSchema)
                .output(founderApprovalQueueSchema)
                .query(() => notBuilt('founderAdmin.approvals.list')),
            },
      ),
      // W1 control room (tier definitions, pricing layers, usage, founder payout approvals). Mounted only with a ControlService.
      ...(control ? { control: createFounderControlRouter(founder, control) } : {}),
      treasury: router({
        exposure: founder
          .input(z.object({}).strict())
          .output(founderTreasuryExposureSchema)
          .query(async () => {
            if (!treasury) return notBuilt('founderAdmin.treasury.exposure');
            // Computed live from the payout book, withdrawals and the conversion reader: "as of" is now.
            const perAsset = await treasuryExposureView(treasury.sql, treasury.limits, treasury.inventory);
            return { freshness: { asOf: new Date().toISOString(), lagSeconds: 0 }, perAsset };
          }),
      }),
    }),
  });
}
