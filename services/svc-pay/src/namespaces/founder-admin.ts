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
  founderPendingChangeListInputSchema,
  founderPendingChangeListSchema,
  founderApprovalQueueInputSchema,
  founderApprovalQueueSchema,
  founderApprovalDestinationInputSchema,
  founderApprovalDestinationSchema,
  founderTreasuryExposureSchema,
  conversionResolveProposeInputSchema,
  conversionResolveProposeResultSchema,
  conversionResolveConfirmInputSchema,
  conversionResolveConfirmResultSchema,
  conversionLateFillProposeInputSchema,
  conversionLateFillProposeResultSchema,
  conversionLateFillConfirmResultSchema,
  conversionLateFillBookProposeInputSchema,
  conversionLateFillBookProposeResultSchema,
  conversionLateFillBookConfirmResultSchema,
  conversionLateFillSweepResultSchema,
  conversionHoldSweepResultSchema,
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
import type { ConversionService } from '../conversion/service.js';
import { mapConversionError } from '../conversion/errors.js';
import type { PayHaltStore } from '../halts/store.js';
import { createFounderControlRouter, founderApprovalProcedures, founderChangeProcedures } from './founder-control.js';
import { founderProcedure, type FounderContext } from './founder-procedure.js';
import { readMerchantDrilldown } from './merchant-drilldown.js';
import { guarded } from './control-errors.js';
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
  /** Halt store for `founderAdmin.merchants.drilldown`. Without it the drill-down stays `pay.not_built` rather than claiming nothing is halted. */
  halts?: PayHaltStore;
  /** W6: founder resolve of a placing conversion. Without it those procedures refuse with `pay.not_built`. */
  conversion?: ConversionService;
}

export function createFounderAdminRouter(founderAuthority: FounderAuthority, mounts: FounderAdminMounts = {}) {
  const { metrics, registries, treasury, control, halts, conversion } = mounts;
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
          .query(({ input }) => {
            if (!metrics || !control || !halts) return notBuilt('founderAdmin.merchants.drilldown');
            return wrap(() =>
              guarded(() =>
                readMerchantDrilldown({
                  metrics,
                  control,
                  halts,
                  merchantId: input.merchantId,
                  window: input.window,
                }),
              ),
            );
          }),
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
              pending: founder
                .input(founderPendingChangeListInputSchema)
                .output(founderPendingChangeListSchema)
                .query(() => notBuilt('founderAdmin.changes.pending')),
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
              destination: founder
                .input(founderApprovalDestinationInputSchema)
                .output(founderApprovalDestinationSchema)
                .mutation(() => notBuilt('founderAdmin.approvals.destination')),
            },
      ),
      // W1 control room (tier definitions, pricing layers, usage, founder payout approvals). Mounted only with a ControlService.
      ...(control ? { control: createFounderControlRouter(founder, control) } : {}),
      conversion: router({
        resolve: router({
          propose: founder
            .input(conversionResolveProposeInputSchema)
            .output(conversionResolveProposeResultSchema)
            .mutation(async ({ ctx, input }) => {
              if (!conversion) return notBuilt('founderAdmin.conversion.resolve.propose');
              try {
                return await conversion.proposeResolve((ctx as FounderContext).founderUserId, input);
              } catch (error) {
                throw mapConversionError(error);
              }
            }),
          confirm: founder
            .input(conversionResolveConfirmInputSchema)
            .output(conversionResolveConfirmResultSchema)
            .mutation(async ({ ctx, input }) => {
              if (!conversion) return notBuilt('founderAdmin.conversion.resolve.confirm');
              try {
                return await conversion.confirmResolve((ctx as FounderContext).founderUserId, input);
              } catch (error) {
                throw mapConversionError(error);
              }
            }),
        }),
        holds: router({
          sweep: founder
            .input(z.object({}).strict())
            .output(conversionHoldSweepResultSchema)
            .mutation(async ({ ctx }) => {
              if (!conversion) return notBuilt('founderAdmin.conversion.holds.sweep');
              try {
                return await conversion.sweepOrphanHolds((ctx as FounderContext).founderUserId);
              } catch (error) {
                throw mapConversionError(error);
              }
            }),
        }),
        lateFill: router({
          propose: founder
            .input(conversionLateFillProposeInputSchema)
            .output(conversionLateFillProposeResultSchema)
            .mutation(async ({ ctx, input }) => {
              if (!conversion) return notBuilt('founderAdmin.conversion.lateFill.propose');
              try {
                return await conversion.proposeLateFillAck((ctx as FounderContext).founderUserId, input);
              } catch (error) {
                throw mapConversionError(error);
              }
            }),
          confirm: founder
            .input(conversionResolveConfirmInputSchema)
            .output(conversionLateFillConfirmResultSchema)
            .mutation(async ({ ctx, input }) => {
              if (!conversion) return notBuilt('founderAdmin.conversion.lateFill.confirm');
              try {
                return await conversion.confirmLateFillAck((ctx as FounderContext).founderUserId, input);
              } catch (error) {
                throw mapConversionError(error);
              }
            }),
          sweep: founder
            .input(z.object({}).strict())
            .output(conversionLateFillSweepResultSchema)
            .mutation(async ({ ctx }) => {
              if (!conversion) return notBuilt('founderAdmin.conversion.lateFill.sweep');
              try {
                return await conversion.sweepLateFills((ctx as FounderContext).founderUserId, { force: true });
              } catch (error) {
                throw mapConversionError(error);
              }
            }),
          book: router({
            propose: founder
              .input(conversionLateFillBookProposeInputSchema)
              .output(conversionLateFillBookProposeResultSchema)
              .mutation(async ({ ctx, input }) => {
                if (!conversion) return notBuilt('founderAdmin.conversion.lateFill.book.propose');
                try {
                  return await conversion.proposeLateFillBook((ctx as FounderContext).founderUserId, input);
                } catch (error) {
                  throw mapConversionError(error);
                }
              }),
            confirm: founder
              .input(conversionResolveConfirmInputSchema)
              .output(conversionLateFillBookConfirmResultSchema)
              .mutation(async ({ ctx, input }) => {
                if (!conversion) return notBuilt('founderAdmin.conversion.lateFill.book.confirm');
                try {
                  return await conversion.confirmLateFillBook((ctx as FounderContext).founderUserId, input);
                } catch (error) {
                  throw mapConversionError(error);
                }
              }),
          }),
        }),
      }),
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
