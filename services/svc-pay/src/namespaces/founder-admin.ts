import {
  TRPCError,
  router,
  founderMerchantListInputSchema,
  founderMerchantListSchema,
  founderMerchantDrilldownInputSchema,
  founderMerchantDrilldownSchema,
  founderMerchantSectionInputSchema,
  founderMerchantSectionSchema,
  founderRecentMerchantsInputSchema,
  founderRecentMerchantsSchema,
  founderPayoutListInputSchema,
  founderPayoutListSchema,
  founderDisputeListInputSchema,
  founderDisputeListSchema,
  founderLiveSummarySchema,
  founderRiskSummaryInputSchema,
  founderRiskSummarySchema,
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
import { createDepositSettingsRouter, type DepositSettingsMountDeps } from '../custody/deposits/settings.js';
import { createDepositFreezesRouter, type DepositFreezesMountDeps } from '../custody/deposits/freezes.js';
import { createDepositTravelRuleRouter, type DepositTravelRuleMountDeps } from '../custody/deposits/travel-rule.js';
import { createRegistriesRouter, type RegistriesMountDeps } from '../registries/index.js';
import { createCategoryPolicyRouter, type CategoryPolicyMountDeps } from '../onboarding-policy/category-router.js';
import { createCustodyRouter, type CustodyMountDeps } from '../custody/router.js';
import { createPurchaseHoldRouter, type PurchaseHoldMountDeps } from '../withdrawals/purchase-holds/router.js';
import { createWithdrawalQuoteRouter, type WithdrawalQuoteMountDeps } from '../withdrawals/quotes/router.js';
import { createWithdrawalNetworkRulesRouter, type WithdrawalNetworkRulesMountDeps } from '../withdrawals/network-rules/service.js';
import { createTravelRuleRouter, type TravelRuleMountDeps } from '../travel-rule/router.js';
import { createWithdrawalReturnRouter, type WithdrawalReturnMountDeps } from '../withdrawals/returns/router.js';
import { createAllowlistFounderRouter, type AllowlistMountDeps } from '../withdrawals/allowlist/router.js';
import { createWithdrawalApprovalFounderRouter, type WithdrawalApprovalMountDeps } from '../withdrawals/approvals/router.js';
import { createWithdrawalLimitsRouter, type WithdrawalLimitsMountDeps } from '../limits/change-router.js';
import { createFounderMerchantReads } from './founder-merchant-reads.js';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { PayError } from '../payment-service.js';
import type { PayService } from '../payment-service.js';
import type { MerchantStarterFee } from '../starter-fee.js';
import type { DisputeCaseStore } from '../fraud/dispute-case.js';

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
  /** RC-merchant-08: the business category table (`founderAdmin.categoryPolicy.*`). Mounted only when supplied. */
  categoryPolicy?: CategoryPolicyMountDeps;
  /** W-deposit-04: the owner's customer deposit settings. Mounted only when supplied. */
  depositSettings?: DepositSettingsMountDeps;
  depositFreezes?: DepositFreezesMountDeps;
  /** W-deposit-07: the inbound travel rule on large chain deposits (`founderAdmin.depositTravelRule.*`). Mounted only when supplied. */
  depositTravelRule?: DepositTravelRuleMountDeps;
  /** W-withdraw-05: owner-set withdrawal limits (`founderAdmin.limits.*`). Mounted only when supplied. */
  limits?: WithdrawalLimitsMountDeps;
  /** W-custody-ops-01: the custody account model (`founderAdmin.custody.*`). Mounted only when supplied. */
  custody?: CustodyMountDeps;
  /** W-withdraw-13: holds on funds bought by card, ACH or PayPal (`founderAdmin.purchaseHolds.*`). Mounted only when supplied. */
  purchaseHolds?: PurchaseHoldMountDeps;
  /** W-withdraw-04: withdrawal fee quote policy and quote read (`founderAdmin.withdrawalQuotes.*`). Mounted only when supplied. */
  withdrawalQuotes?: WithdrawalQuoteMountDeps;
  /** W-withdraw-02: the owner's withdrawal rules per asset and network (`founderAdmin.withdrawalNetworkRules.*`). Mounted only when supplied. */
  withdrawalNetworkRules?: WithdrawalNetworkRulesMountDeps;
  /** W-compliance-notices-04: outbound travel rule (`founderAdmin.travelRule.*`). Mounted only when supplied. */
  travelRule?: TravelRuleMountDeps;
  /** W-withdraw-07: returned withdrawals, recorded and parked (`founderAdmin.withdrawalReturns.*`). Mounted only when supplied. */
  withdrawalReturns?: WithdrawalReturnMountDeps;
  /** W-withdraw-11: policy and the due sweep for multi-approval withdrawals (`founderAdmin.withdrawalApprovals.*`). Mounted only when supplied. */
  withdrawalApprovals?: WithdrawalApprovalMountDeps;
  /** W-withdraw-10: quorum, reads and suspension for the withdrawal allowlist (`founderAdmin.allowlist.*`). Mounted only when supplied. */
  allowlist?: AllowlistMountDeps;
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
  /** Pay database for founder merchant reads. Without it those procedures refuse with `pay.not_built`. */
  sql?: Sql;
  /** Payment, refund, settlement and link lists. Without it those sections refuse with `pay.not_built`. */
  pay?: PayService;
  /** Same dispute store the merchant pages use. Without it the in-memory store is empty. */
  disputes?: DisputeCaseStore;
  /** Published local-test starter fee. Omitted or null means it is not set. */
  starterFee?: MerchantStarterFee | null;
}

const PAY_SECTIONS = new Set(['payments', 'refunds', 'settlements', 'links', 'destinations']);

async function readWrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MerchantOpsError) {
      const code =
        err.kind === 'not_found'
          ? 'NOT_FOUND'
          : err.kind === 'forbidden'
            ? 'FORBIDDEN'
            : err.kind === 'conflict'
              ? 'CONFLICT'
              : err.kind === 'precondition'
                ? 'PRECONDITION_FAILED'
                : err.kind === 'unavailable'
                  ? 'SERVICE_UNAVAILABLE'
                  : 'BAD_REQUEST';
      throw new TRPCError({ code, message: err.code, cause: err });
    }
    if (err instanceof PayError) {
      throw new TRPCError({
        code: err.code === 'pay.merchant_not_found' ? 'NOT_FOUND' : 'BAD_REQUEST',
        message: err.code,
        cause: err,
      });
    }
    throw metricsToTrpcError(err);
  }
}

export function createFounderAdminRouter(founderAuthority: FounderAuthority, mounts: FounderAdminMounts = {}) {
  const {
    metrics,
    registries,
    categoryPolicy,
    depositSettings,
    depositFreezes,
    depositTravelRule,
    limits,
    custody,
    purchaseHolds,
    travelRule,
    withdrawalQuotes,
    withdrawalNetworkRules,
    withdrawalReturns,
    withdrawalApprovals,
    allowlist,
    treasury,
    control,
    halts,
    conversion,
  } = mounts;
  const reads = mounts.sql
    ? createFounderMerchantReads({ sql: mounts.sql, pay: mounts.pay, disputes: mounts.disputes, starterFee: mounts.starterFee })
    : null;
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
      // RC-merchant-08: business categories (src/onboarding-policy). Mounted only when its deps are supplied.
      ...(categoryPolicy ? { categoryPolicy: createCategoryPolicyRouter({ founderAuthority, ...categoryPolicy }) } : {}),
      ...(depositSettings ? { depositSettings: createDepositSettingsRouter({ founderAuthority, ...depositSettings }) } : {}),
      // W-compliance-notices-03: compliance freezes on deposit addresses; an unfreeze takes a second founder (src/custody/deposits/freezes).
      ...(depositFreezes ? { depositFreezes: createDepositFreezesRouter({ founderAuthority, ...depositFreezes }) } : {}),
      // W-deposit-07: inbound travel rule per asset; a large deposit is held until its declaration is reviewed (src/custody/deposits/travel-rule).
      ...(depositTravelRule ? { depositTravelRule: createDepositTravelRuleRouter({ founderAuthority, ...depositTravelRule }) } : {}),
      // W-withdraw-05: owner-set withdrawal limits per KYC tier and asset (src/limits). Mounted only when its deps are supplied.
      ...(limits ? { limits: createWithdrawalLimitsRouter({ founderAuthority, ...limits }) } : {}),
      // W-custody-ops-01: custody entities, vaults and wallets (src/custody). Mounted only when its deps are supplied.
      ...(custody ? { custody: createCustodyRouter({ founderAuthority, ...custody }) } : {}),
      // W-withdraw-13: purchase holds (src/withdrawals/purchase-holds). Mounted only when its deps are supplied.
      ...(purchaseHolds ? { purchaseHolds: createPurchaseHoldRouter({ founderAuthority, ...purchaseHolds }) } : {}),
      // W-withdraw-04: withdrawal fee quotes (src/withdrawals/quotes). Mounted only when its deps are supplied.
      ...(withdrawalQuotes ? { withdrawalQuotes: createWithdrawalQuoteRouter({ founderAuthority, ...withdrawalQuotes }) } : {}),
      // W-withdraw-02: minimum, maximum, step and tag rule per asset and network (src/withdrawals/network-rules).
      ...(withdrawalNetworkRules
        ? { withdrawalNetworkRules: createWithdrawalNetworkRulesRouter({ founderAuthority, ...withdrawalNetworkRules }) }
        : {}),
      // W-compliance-notices-04: outbound travel rule (src/travel-rule). Mounted only when its deps are supplied.
      ...(travelRule ? { travelRule: createTravelRuleRouter({ founderAuthority, ...travelRule }) } : {}),
      // W-withdraw-07: returned withdrawals (src/withdrawals/returns). Mounted only when its deps are supplied.
      ...(withdrawalReturns ? { withdrawalReturns: createWithdrawalReturnRouter({ founderAuthority, ...withdrawalReturns }) } : {}),
      ...(withdrawalApprovals
        ? { withdrawalApprovals: createWithdrawalApprovalFounderRouter({ founderAuthority, ...withdrawalApprovals }) }
        : {}),
      // W-withdraw-10: the withdrawal allowlist (src/withdrawals/allowlist). Mounted only when its deps are supplied.
      ...(allowlist ? { allowlist: createAllowlistFounderRouter({ founderAuthority, ...allowlist }) } : {}),
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
        section: founder
          .input(founderMerchantSectionInputSchema)
          .output(founderMerchantSectionSchema)
          .query(({ ctx, input }) => {
            if (!reads) return notBuilt('founderAdmin.merchants.section');
            if (PAY_SECTIONS.has(input.section) && !reads.hasPay) return notBuilt('founderAdmin.merchants.section');
            return readWrap(() => reads.section((ctx as FounderContext).founderUserId, input));
          }),
        recent: founder
          .input(founderRecentMerchantsInputSchema)
          .output(founderRecentMerchantsSchema)
          .query(({ input }) => (reads ? readWrap(() => reads.recent(input)) : notBuilt('founderAdmin.merchants.recent'))),
      }),
      payouts: router({
        list: founder
          .input(founderPayoutListInputSchema)
          .output(founderPayoutListSchema)
          .query(({ input }) => (reads ? readWrap(() => reads.payoutList(input)) : notBuilt('founderAdmin.payouts.list'))),
      }),
      disputes: router({
        list: founder
          .input(founderDisputeListInputSchema)
          .output(founderDisputeListSchema)
          .query(({ input }) => (reads ? readWrap(() => reads.disputeList(input)) : notBuilt('founderAdmin.disputes.list'))),
      }),
      live: router({
        summary: founder
          .input(z.object({}).strict())
          .output(founderLiveSummarySchema)
          .query(() => (reads ? readWrap(() => reads.live()) : notBuilt('founderAdmin.live.summary'))),
      }),
      risk: router({
        summary: founder
          .input(founderRiskSummaryInputSchema)
          .output(founderRiskSummarySchema)
          .query(({ input }) => (reads ? readWrap(() => reads.risk(input)) : notBuilt('founderAdmin.risk.summary'))),
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
