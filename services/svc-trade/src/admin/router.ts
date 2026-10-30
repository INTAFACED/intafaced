/**
 * tRPC surface the trade operator desk calls. Reads are `admin:read`.
 * Writes are `admin:write`. Procedures exist even when the service is
 * unwired: they refuse `trade_ops_admin_unconfigured`.
 */
import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { AuthError } from '@intafaced/auth';
import { TradeOpsError } from './common.js';
import type { TradeOpsAdmin } from './service.js';

const limit = z.number().int().min(1).max(200);
const id = z.string().guid();
const reason = z.string().trim().min(3).max(500);
const clientRequestId = z.string().trim().min(1).max(128);
const nullableText = z.string().trim().min(1).max(128).nullish();
const approvalId = z.string().trim().min(1).max(128);
const decimalText = z.string().trim().min(1).max(64);
const agreementKind = z.enum(['derivatives_risk', 'margin_terms']);
const versionText = z.string().regex(/^(?:0|[1-9]\d*)$/);
const tenorRow = z.object({ tenor: z.enum(['weekly', 'monthly', 'quarterly']), enabled: z.boolean() }).strict();

/** Charts owner values (C-ops-04). A count is a whole number from 1 to its bound, or null (blank: not set). */
const chartCountSet = <K extends string>(key: K, max: number) =>
  z
    .object({
      key: z.literal(key),
      value: z.number().int().min(1).max(max).nullable(),
      expectedVersion: versionText,
      reason,
      clientRequestId,
    })
    .strict();
const chartOwnerValueSet = z.discriminatedUnion('key', [
  chartCountSet('compareCap', 50),
  chartCountSet('chartCountLimit', 64),
  chartCountSet('drawingCap', 10_000),
  chartCountSet('brushPointCap', 100_000),
  chartCountSet('delayedBoundarySeconds', 86_400),
  chartCountSet('renderBudgetMs', 60_000),
  z
    .object({
      key: z.literal('dataClass'),
      symbol: z.string().trim().min(1).max(64),
      value: z.enum(['real_time', 'delayed', 'end_of_day']).nullable(),
      expectedVersion: versionText,
      reason,
      approvalId,
      clientRequestId,
    })
    .strict(),
]);

const limits = z
  .object({
    collar: z.string().nullable(),
    fatFinger: z.string().nullable(),
    slippageCap: z.string().nullable(),
    throttle: z.string().nullable(),
    circuitBreaker: z.string().nullable(),
    // Optional: a write that leaves them out keeps the market's current open-interest limits.
    oiLimit: z.string().nullable().optional(),
    oiShareBps: z.string().nullable().optional(),
    priceRangeMax: z.string().nullable().optional(),
    priceRangeTrigger: z.string().nullable().optional(),
    priceRangeCadenceSeconds: z.string().nullable().optional(),
  })
  .strict();

const fundingParamsInput = z
  .object({
    baseComponent: z.string().nullable(),
    cap: z.string().nullable(),
    cadenceSeconds: z.number().int().nullable(),
    trimRatioBps: z.number().int().nullable(),
    minSamples: z.number().int().nullable(),
    periodSeconds: z.number().int().nullable(),
    periodAnchor: z.string().nullable(),
  })
  .strict();

const indexSourcesConfig = z
  .object({
    sources: z
      .array(z.object({ sourceId: z.string().trim().min(1).max(64), weight: z.number().int(), enabled: z.boolean() }).strict())
      .max(16),
    params: z
      .object({
        minSources: z.number().int().nullable(),
        outlierBandBps: z.number().int().nullable(),
        maxAgeSeconds: z.number().int().nullable(),
      })
      .strict(),
  })
  .strict();

const expectedVersion = z.string().regex(/^(?:0|[1-9]\d*)$/);

function fail(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof AuthError) {
    throw new TRPCError({ code: error.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN', message: error.message, cause: error });
  }
  if (error instanceof TradeOpsError) {
    const code =
      error.code === 'order_not_found' ||
      error.code === 'position_not_found' ||
      error.code === 'export_not_found' ||
      error.code === 'market_not_found' ||
      error.code === 'vip_application_not_found'
        ? 'NOT_FOUND'
        : 'BAD_REQUEST';
    throw new TRPCError({ code, message: error.message, cause: error });
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: error });
}

export function tradeOpsAdminRouter(admin?: TradeOpsAdmin) {
  const operator = scopedProcedure('admin:read');
  const operatorWrite = scopedProcedure('admin:write');
  const compliance = scopedProcedure('admin:compliance');
  const ready = (): TradeOpsAdmin => {
    if (!admin) {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'trade_ops_admin_unconfigured',
      });
    }
    return admin;
  };
  return router({
    orders: router({
      massCancel: operatorWrite
        .input(
          z.object({
            market: nullableText,
            accountId: id.nullish(),
            reason,
            approvalId: z.string().trim().min(1).max(128),
            clientRequestId,
          }),
        )
        .mutation(({ ctx, input }) => ready().massCancel(ctx.principal, input).catch(fail)),
      get: operator
        .input(z.object({ orderId: id }).strict())
        .query(({ ctx, input }) => ready().getOrder(ctx.principal, input.orderId).catch(fail)),
      list: operator
        .input(
          z.object({
            status: z.string().min(1).max(40),
            market: id.nullish(),
            accountId: id.nullish(),
            from: z.string().nullish(),
            to: z.string().nullish(),
            cursor: z.string().nullish(),
            limit,
          }),
        )
        .query(({ ctx, input }) => ready().listOrders(ctx.principal, input).catch(fail)),
      reconcile: operatorWrite
        .input(z.object({ orderId: id, clientRequestId }).strict())
        .mutation(({ ctx, input }) => ready().reconcile(ctx.principal, input).catch(fail)),
      reconcileStatus: operator.query(({ ctx }) => ready().reconcileStatus(ctx.principal).catch(fail)),
      startReconcileSweep: operatorWrite
        .input(z.object({ clientRequestId }).strict())
        .mutation(({ ctx, input }) => ready().startReconcileSweep(ctx.principal, input).catch(fail)),
    }),
    risk: router({
      get: operator
        .input(z.object({ market: id }).strict())
        .query(({ ctx, input }) => ready().riskGet(ctx.principal, input.market).catch(fail)),
      history: operator
        .input(z.object({ market: id }).strict())
        .query(({ ctx, input }) => ready().riskHistory(ctx.principal, input.market).catch(fail)),
      priceBand: operator
        .input(z.object({ market: id }).strict())
        .query(({ ctx, input }) => ready().riskPriceBand(ctx.principal, input.market).catch(fail)),
      set: operatorWrite
        .input(
          z.object({
            market: id,
            limits,
            expectedVersion: z.string().regex(/^(?:0|[1-9]\d*)$/),
            reason,
            approvalId: z.string().trim().min(1).max(128),
            // The approval's own operation id (identity mints it at propose); its consume refuses any other.
            operationId: z.string().trim().min(1).max(128),
          }),
        )
        .mutation(({ ctx, input }) => ready().riskSet(ctx.principal, input).catch(fail)),
    }),
    fees: router({
      get: operator.query(({ ctx }) => ready().feeScheduleGet(ctx.principal).catch(fail)),
      set: operatorWrite
        .input(
          z.object({
            schedule: z.record(z.string(), z.unknown()),
            effectiveAt: z.string().trim().min(1).max(40),
            expectedVersion: z.string().regex(/^(?:0|[1-9]\d*)$/),
            reason,
            approvalId: z.string().trim().min(1).max(128),
            operationId: z.string().trim().min(1).max(128),
          }),
        )
        .mutation(({ ctx, input }) => ready().feeScheduleSet(ctx.principal, input).catch(fail)),
    }),
    positions: router({
      list: operator
        .input(z.object({ accountId: z.string().nullish(), market: id.nullish(), cursor: z.string().nullish(), limit }))
        .query(({ ctx, input }) => ready().listPositions(ctx.principal, input).catch(fail)),
      get: operator
        .input(z.object({ positionId: id }).strict())
        .query(({ ctx, input }) => ready().getPosition(ctx.principal, input.positionId).catch(fail)),
    }),
    futures: router({
      snapshot: operator
        .input(z.object({ market: id }).strict())
        .query(({ ctx, input }) => ready().futuresSnapshot(ctx.principal, input.market).catch(fail)),
      liquidations: operator
        .input(z.object({ market: id.nullish(), limit }).strict())
        .query(({ ctx, input }) => ready().futuresLiquidations(ctx.principal, input).catch(fail)),
      insuranceHistory: operator
        .input(z.object({ asset: z.string().trim().min(1).max(32), limit }).strict())
        .query(({ ctx, input }) => ready().futuresInsuranceHistory(ctx.principal, input).catch(fail)),
    }),
    exports: router({
      create: operator
        .input(
          z.object({
            kind: z.enum(['orders', 'fills', 'positions']),
            filters: z.object({ market: id.nullish(), accountId: z.string().nullish() }).strict(),
            clientRequestId,
          }),
        )
        .mutation(({ ctx, input }) => ready().createExport(ctx.principal, input).catch(fail)),
      get: operator.input(z.object({ id }).strict()).query(({ ctx, input }) => ready().getExport(ctx.principal, input.id).catch(fail)),
      download: operator
        .input(z.object({ ref: z.string().min(1).max(512) }).strict())
        .mutation(({ ctx, input }) => ready().downloadExport(ctx.principal, input.ref).catch(fail)),
    }),
    audit: router({
      feed: operator
        .input(
          z.object({
            cursor: z.string().nullish(),
            kind: z.string().max(80).nullish(),
            accountId: z.string().nullish(),
            from: z.string().nullish(),
            to: z.string().nullish(),
            limit,
          }),
        )
        .query(({ ctx, input }) => ready().auditFeed(ctx.principal, input).catch(fail)),
    }),
    marketMaker: router({
      seedReport: operator
        .input(z.object({ market: id, from: z.string().nullish(), to: z.string().nullish() }))
        .query(({ ctx, input }) => ready().seedReport(ctx.principal, input).catch(fail)),
      setSeed: operatorWrite
        .input(z.object({ market: id, enabled: z.boolean(), approvalId: z.string().min(1).max(128), clientRequestId }))
        .mutation(({ ctx, input }) => ready().setSeed(ctx.principal, input).catch(fail)),
    }),
    fundingParams: router({
      get: operator
        .input(z.object({ market: id }).strict())
        .query(({ ctx, input }) => ready().funding.paramsGet(ctx.principal, input.market).catch(fail)),
      set: operatorWrite
        .input(z.object({ market: id, params: fundingParamsInput, expectedVersion, reason, approvalId, clientRequestId }).strict())
        .mutation(({ ctx, input }) => ready().funding.paramsSet(ctx.principal, input).catch(fail)),
    }),
    indexSources: router({
      get: operator
        .input(z.object({ market: id }).strict())
        .query(({ ctx, input }) => ready().funding.sourcesGet(ctx.principal, input.market).catch(fail)),
      set: operatorWrite
        .input(z.object({ market: id, config: indexSourcesConfig, expectedVersion, reason, approvalId, clientRequestId }).strict())
        .mutation(({ ctx, input }) => ready().funding.sourcesSet(ctx.principal, input).catch(fail)),
    }),
    fundingPeriods: router({
      recent: operator
        .input(z.object({ market: id.nullish(), limit, sampleLimit: z.number().int().min(1).max(1000) }).strict())
        .query(({ ctx, input }) => ready().funding.periods(ctx.principal, input).catch(fail)),
    }),
    futuresListing: router({
      create: operatorWrite
        .input(
          z
            .object({
              symbol: z.string().trim().min(1).max(64),
              baseAsset: z.string().trim().min(1).max(32),
              quoteAsset: z.string().trim().min(1).max(32),
              tickSize: decimalText,
              lotSize: decimalText,
              minQty: decimalText,
              maxQty: decimalText.nullable(),
              minNotional: decimalText,
              makerBps: z.number().int().min(0),
              takerBps: z.number().int().min(0),
              expiryAt: z.string().trim().min(1).max(64),
              status: z.enum(['pending', 'active']).optional(),
              family: z.enum(['linear', 'inverse']).nullish(),
              settleAsset: z.string().trim().min(1).max(32).nullish(),
              displayName: z.string().trim().min(1).max(128).nullish(),
              reason,
              approvalId,
              clientRequestId,
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => ready().futuresContracts.listingCreate(ctx.principal, input).catch(fail)),
    }),
    futuresSchedule: router({
      get: operator.query(({ ctx }) => ready().futuresContracts.scheduleGet(ctx.principal).catch(fail)),
      set: operatorWrite
        .input(
          z
            .object({
              tenors: z.array(tenorRow).min(1).max(3),
              expectedVersion: z.string().regex(/^(?:0|[1-9]\d*)$/),
              reason,
              approvalId,
              clientRequestId,
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => ready().futuresContracts.scheduleSet(ctx.principal, input).catch(fail)),
    }),
    futuresPremarket: router({
      get: operator
        .input(z.object({ market: id }).strict())
        .query(({ ctx, input }) => ready().futuresContracts.premarketGet(ctx.principal, input.market).catch(fail)),
      set: operatorWrite
        .input(
          z
            .object({
              market: id,
              flatFundingRate: decimalText.nullable(),
              markClampBps: z.number().int().min(1).max(2_147_483_647).nullable(),
              expectedVersion: z.string().regex(/^(?:0|[1-9]\d*)$/),
              reason,
              approvalId,
              clientRequestId,
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => ready().futuresContracts.premarketSet(ctx.principal, input).catch(fail)),
      convert: operatorWrite
        .input(z.object({ market: id, reason, approvalId, clientRequestId }).strict())
        .mutation(({ ctx, input }) => ready().futuresContracts.premarketConvert(ctx.principal, input).catch(fail)),
    }),
    chartOwnerValues: router({
      get: operator.query(({ ctx }) => ready().chartOwnerValues.get(ctx.principal).catch(fail)),
      set: operatorWrite
        .input(chartOwnerValueSet)
        .mutation(({ ctx, input }) => ready().chartOwnerValues.set(ctx.principal, input).catch(fail)),
    }),
    agreements: router({
      get: operator
        .input(z.object({ kind: agreementKind }).strict())
        .query(({ ctx, input }) => ready().agreements.agreementGet(ctx.principal, input.kind).catch(fail)),
      publish: operatorWrite
        .input(
          z
            .object({
              kind: agreementKind,
              texts: z
                .array(
                  z
                    .object({
                      region: z.string().trim().min(1).max(16),
                      title: z.string().trim().min(1).max(200),
                      body: z.string().trim().min(1).max(200_000),
                    })
                    .strict(),
                )
                .min(1)
                .max(64),
              expectedVersion: versionText,
              reason,
              approvalId,
              clientRequestId,
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => ready().agreements.agreementPublish(ctx.principal, input).catch(fail)),
      list: operator
        .input(
          z
            .object({
              kind: agreementKind.nullish(),
              version: z.number().int().min(1).nullish(),
              region: z.string().trim().min(1).max(16).nullish(),
              userId: z.string().guid().nullish(),
              from: z.string().nullish(),
              to: z.string().nullish(),
              cursor: z.string().nullish(),
              limit,
            })
            .strict(),
        )
        .query(({ ctx, input }) => ready().agreements.list(ctx.principal, input).catch(fail)),
      export: operator
        .input(
          z
            .object({
              kind: agreementKind.nullish(),
              version: z.number().int().min(1).nullish(),
              region: z.string().trim().min(1).max(16).nullish(),
              userId: z.string().guid().nullish(),
              from: z.string().nullish(),
              to: z.string().nullish(),
              reason,
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => ready().agreements.export(ctx.principal, input).catch(fail)),
    }),
    eligibilityRules: router({
      get: operator.query(({ ctx }) => ready().agreements.eligibilityRulesGet(ctx.principal).catch(fail)),
      set: operatorWrite
        .input(
          z
            .object({
              questions: z
                .array(
                  z
                    .object({
                      id: z.string().trim().min(1).max(64),
                      prompt: z.string().trim().min(1).max(2000),
                      options: z
                        .array(z.object({ id: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(1000) }).strict())
                        .min(2)
                        .max(10),
                      correctOptionId: z.string().trim().min(1).max(64),
                    })
                    .strict(),
                )
                .min(1)
                .max(100),
              passMark: z.number().int().min(1).max(100),
              minKycTier: z.enum(['none', 'basic', 'full', 'institutional']),
              expectedVersion: versionText,
              reason,
              approvalId,
              clientRequestId,
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => ready().agreements.eligibilityRulesSet(ctx.principal, input).catch(fail)),
    }),
    vipApplications: router({
      list: operator
        .input(
          z
            .object({ status: z.enum(['pending', 'approved', 'approved_no_trial', 'rejected']).nullish(), limit: limit.optional() })
            .strict(),
        )
        .query(({ ctx, input }) => ready().vipApplications.list(ctx.principal, input).catch(fail)),
      // A mutation: each opening is written to the operator audit.
      proof: compliance
        .input(z.object({ applicationId: id, reason }).strict())
        .mutation(({ ctx, input }) => ready().vipApplications.proof(ctx.principal, input).catch(fail)),
      review: operatorWrite
        .input(
          z
            .object({
              applicationId: id,
              decision: z.enum(['approve', 'reject']),
              reason,
              approvalId,
              operationId: z.string().trim().min(1).max(128),
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => ready().vipApplications.review(ctx.principal, input).catch(fail)),
      grantTrial: operatorWrite
        .input(z.object({ applicationId: id, reason, approvalId, operationId: z.string().trim().min(1).max(128) }).strict())
        .mutation(({ ctx, input }) => ready().vipApplications.grantTrial(ctx.principal, input).catch(fail)),
    }),
    copyBotsOtc: router({
      metrics: operator.query(({ ctx }) => ready().copyBotsOtc.metrics(ctx.principal).catch(fail)),
      // The desk read scope at the door; the lookup scope (COPY_LOOKUP_SCOPE) is checked in the service, before any read.
      lookup: operator
        .input(z.object({ userId: z.string().trim().min(1).max(128) }).strict())
        .query(({ ctx, input }) => ready().copyBotsOtc.lookup(ctx.principal, input).catch(fail)),
      quoteDesk: operator.query(({ ctx }) => ready().copyBotsOtc.quoteDesk(ctx.principal).catch(fail)),
    }),
    markets: router({
      statusHistory: operator
        .input(z.object({ market: id, cursor: z.string().nullish(), limit }))
        .query(({ ctx, input }) => ready().statusHistory(ctx.principal, input).catch(fail)),
    }),
  });
}
