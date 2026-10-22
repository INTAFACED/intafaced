import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { AuthError, requireMfa } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { publicProcedure, router, scopedProcedure } from '@intafaced/contracts';
import { OMS_WRITE_CALLER, requireOmsWriteService } from './oms-write-hmac.js';
import { SealedHouseTenantRegistry, type TenantDescribe, type TenantRefusal } from '@intafaced/execution-house-tenant';
import type { CaptureLake } from '@intafaced/venue-adapter';
import { cancelOmsOrder, type OmsCancelFn } from './oms-cancel.js';
import { killInFlightExecution } from './oms-kill.js';
import {
  consumeExecutionHalt,
  haltScope,
  inFlightChildren,
  assertIdempotencyKey,
  OperatorDeskError,
  EXECUTION_EMS_STORE_UNWIRED,
  EXECUTION_IDEMPOTENCY_CONFLICT,
} from './operator-desk.js';
import { drainInFlightAlgo } from './oms-drain.js';
import { cancelRemainingParentChildren } from './oms-cancel-remaining.js';
import { attributeChildFillsToParent } from './oms-attribute.js';
import { repairFailedHedgeChild } from './oms-repair-hedge.js';
import { retryFailedHedgeChild } from './oms-retry-hedge.js';
import { listFailedHedgeChildren } from './oms-failed-hedges.js';
import { listLiveEmsChildren } from './oms-live-children.js';
import { InMemoryAlgoPauseStore, pauseInFlightAlgo, type AlgoPauseStore } from './oms-pause.js';
import { resumeInFlightAlgo } from './oms-resume.js';
import { resolveMatchingVenueHalt, type MatchingVenueHaltPort } from './oms-matching-venue-halt.js';
import { handleKillBasketDoor, handleStartBasketDoor } from './oms-basket-http.js';
import { InMemoryApprovedAlgoParentStore, startApprovedAlgoParent, type ApprovedAlgoParentStore, type AlgoJobsGate } from './oms-start.js';
import { stopRunningAlgoParent } from './oms-stop.js';
import { undeployStoppedAlgoParent } from './oms-undeploy.js';
import { undeployDrainStoppedAlgoParent } from './oms-undeploy-drain.js';
import { expireAlgoParent } from './oms-expire.js';
import { releaseExpiredParentResidual } from './oms-release-residual.js';
import { paperRunAlgoParent } from './oms-paper.js';
import { promotePaperParentToLive } from './oms-promote.js';
import { stageApprovedParent } from './oms-stage.js';
import { releaseStagedParentToLive } from './oms-release.js';
import { abandonStagedParent } from './oms-abandon.js';
import { sliceLiveAlgoParent } from './oms-slice.js';
import { scheduleSliceLiveAlgoParent } from './oms-schedule-slice.js';
import { listUnattendedLiveParents } from './oms-unattended.js';
import { listUnconfirmedChildFills } from './oms-unconfirmed.js';
import { assignOrphanedChildFill, listOrphanedChildFills } from './oms-assign.js';
import { killUnattendedLiveParent } from './oms-unattended-kill.js';
import { handleKillParentDoor } from './oms-kill-parent-http.js';
import type { OmsMatchingS2s } from './oms-kill-parent-matching.js';
import { claimLiveAlgoParent, readLiveAlgoParentOwnership, unclaimLiveAlgoParent } from './oms-claim.js';
import { acceptLiveAlgoParentPass, passLiveAlgoParent, rejectLiveAlgoParentPass, timeoutLiveAlgoParentPass } from './oms-pass.js';
import { shiftLiveAlgoParent } from './oms-shift.js';
import { confirmChildFill, InMemoryFillConfirmStore, readChildFillConfirmation, type FillConfirmStore } from './oms-fill-confirm.js';
import { InMemoryManualFillStore, recordManualChildFill, type ManualFillStore } from './oms-manual-fill.js';
import { assignChildFill, correctChildFill, InMemoryFillAssignStore, type FillAssignStore } from './oms-fill-assign.js';
import { approveAlgoParent } from './oms-approve.js';
import { executeOmsRoute, type OmsSubmitFn } from './oms-execute.js';
import { fetchOmsOrder, type OmsFetchFn } from './oms-fetch.js';
import { listOmsOpenOrders, type OmsOpenOrdersFn } from './oms-open-orders.js';
import { observeOmsBalances, type OmsBalancesFn } from './oms-balances.js';
import { observeOmsPositions, type OmsPositionsFn } from './oms-positions.js';
import { observeOmsBorrow, type OmsBorrowFn } from './oms-borrow.js';
import { observeOmsFunding, type OmsFundingFn } from './oms-funding.js';
import { observeOmsLatency, type OmsLatencyFn } from './oms-latency.js';
import { observeOmsMarkets, type OmsMarketsFn } from './oms-markets.js';
import { observeOmsRails, type OmsRailsFn } from './oms-rails.js';
import { observeOmsSnapshot, type OmsSnapshotFn } from './oms-snapshot.js';
import {
  assertEmsListLimit,
  assertOrphanedListLimit,
  assertUnattendedListLimit,
  EmsListLimitUnsetError,
  OrphanedListLimitUnsetError,
  UnattendedListLimitUnsetError,
} from './ems-list-limit.js';
import { scanOmsExternalArb } from './oms-arbitrage.js';
import { readArbOpportunities, type ArbOpportunityFeed } from './arb-opportunities.js';
import { planOmsArbAtomicLegs } from './oms-arb-plan-legs.js';
import { executeOmsArbAtomicLegs } from './oms-arb-execute-legs.js';
import { describeExecutionSpine } from './oms-spine.js';
import { planOmsExternalMmHedge, quoteOmsExternalMm } from './oms-market-making.js';
import { planOmsRoute } from './oms-plan.js';
import { runTcaRun, TCA_BENCHMARK_CLASSES } from './oms-tca.js';
import { runTcaForParent } from './oms-tca-parent.js';
import { recordMarkoutsForParent } from './oms-tca-markouts.js';
import { withExecutionSpan } from './tracing.js';
import type { EmsOrderStore } from './oms-ems-store.js';

const omsWriteProcedure = publicProcedure.use(({ ctx, next }) => {
  requireOmsWriteService(ctx.service);
  return next({ ctx });
});

const tenantIdInput = z.object({ tenantId: z.string().min(1).max(128) });

const describeOutput = z.union([
  z.object({
    tenantId: z.string(),
    keyNamespace: z.string(),
    killed: z.boolean(),
    auditCount: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['internal_venue', 'kill_switch', 'unknown_tenant', 'invalid_venue']),
    detail: z.string(),
  }),
]);

function isRefusal(value: TenantDescribe | TenantRefusal): value is TenantRefusal {
  return 'ok' in value && value.ok === false;
}

const decimalString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are positive decimal strings');
const signedDecimalString = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'amounts are signed decimal strings');

const latencyGradeInput = z.object({
  venueId: z.string().min(1),
  measurement: z.literal('rest-round-trip'),
  grade: z.enum(['A', 'B', 'C', 'D', 'F']).nullable(),
  samples: z.number().int().nonnegative(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  rejectRateBps: z.number().nullable(),
  errorRateBps: z.number().nullable(),
  staleMs: z.number().nullable(),
  provisional: z.boolean(),
  reasons: z.array(z.string()).readonly(),
});

const omsVenueInput = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']),
  price: decimalString,
  amount: decimalString,
  feeBps: z.number().int().nonnegative(),
  costTerms: z.object({
    feeBps: z.number().nullable(),
    expectedImpactBps: z.number().nullable(),
    transferCostBps: z.number().nullable(),
    latencyGrade: latencyGradeInput.nullable(),
  }),
});

const omsPlanInput = z.object({
  symbol: z.string().min(1).max(64),
  side: z.enum(['buy', 'sell']),
  amount: decimalString,
  venues: z.array(omsVenueInput).min(1).max(16),
  tenantId: z.string().min(1).max(128).optional(),
  parentClientOrderId: z.string().min(1).max(128).optional(),
  executionGroupId: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

const sorCostTermsInput = z.object({
  feeBps: z.number().nullable(),
  expectedImpactBps: z.number().nullable(),
  transferCostBps: z.number().nullable(),
  latencyGrade: latencyGradeInput.nullable(),
});

const omsArbScanInput = z.object({
  symbol: z.string().min(1).max(64),
  amount: decimalString,
  scanClass: z.enum(['cross-exchange', 'triangular', 'basis', 'funding']).default('cross-exchange'),
  fundingRate: z.string().max(64).nullable().optional(),
  quotes: z
    .array(
      z.object({
        venueId: z.string().min(1).max(128),
        kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']),
        price: decimalString.nullable(),
        amount: decimalString,
        asOfMs: z.number().int().nullable(),
      }),
    )
    .max(32),
  costTermsByVenue: z.record(z.string().min(1).max(128), sorCostTermsInput),
  inventory: z.object({
    prePositionedByVenue: z.record(z.string().min(1).max(128), z.boolean()),
  }),
  nowMs: z.number().int(),
  maxQuoteAgeMs: z.number().int().nonnegative().nullable(),
});

const omsArbPlanLegsInput = z.object({
  symbol: z.string().min(1).max(64),
  amount: decimalString,
  buyVenueId: z.string().min(1).max(128),
  sellVenueId: z.string().min(1).max(128),
  inventory: z.object({
    prePositionedByVenue: z.record(z.string().min(1).max(128), z.boolean()),
  }),
});

const omsArbExecuteLegsInput = omsArbPlanLegsInput.extend({
  parentClientOrderId: z.string().min(1).max(128),
  executionGroupId: z.string().min(1).max(128).optional(),
  buyLimitPrice: decimalString,
  sellLimitPrice: decimalString,
});

const omsBasketLegInput = z.object({
  name: z.string().max(64).optional().nullable(),
  qty: z.string().max(64).optional().nullable(),
  marketId: z.string().max(128).optional().nullable(),
  orderId: z.string().max(128).optional().nullable(),
  side: z.string().max(16).optional().nullable(),
  type: z.string().max(16).optional().nullable(),
  tif: z.string().max(16).optional().nullable(),
  price: z.string().max(64).optional().nullable(),
  accountId: z.string().max(128).optional().nullable(),
  lifecycleProof: z.unknown().optional(),
});

const omsStartBasketInput = z.object({
  parentClientOrderId: z.string().max(200).optional(),
  kind: z.string().max(64).optional(),
  approved: z.boolean().optional(),
  status: z.string().max(64).optional(),
  paper: z.boolean().optional(),
  legs: z.array(omsBasketLegInput).max(32).optional(),
  partialFailurePolicy: z.string().max(64).optional().nullable(),
  credit: z.string().max(64).optional().nullable(),
  remaining: z.string().max(64).optional().nullable(),
  operatorId: z.string().max(128).optional(),
  accountId: z.string().max(128).optional().nullable(),
  type: z.string().max(16).optional().nullable(),
  tif: z.string().max(16).optional().nullable(),
  lifecycleProof: z.unknown().optional(),
});

const omsKillBasketInput = z.object({
  children: z
    .array(
      z.object({
        marketId: z.string().max(128).optional().nullable(),
        orderId: z.string().max(200).optional().nullable(),
      }),
    )
    .max(32)
    .optional(),
});

const omsMmInventoryInput = z.object({
  position: signedDecimalString,
  minPosition: signedDecimalString,
  maxPosition: signedDecimalString,
});

const omsMmKillInput = z.object({
  adminKill: z.boolean(),
  inventory: omsMmInventoryInput,
  volatility: z.object({
    realizedVolBps: z.number().int().nullable(),
    maxVolBps: z.number().int(),
  }),
});

const omsMmQuoteInput = z.object({
  symbol: z.string().min(1).max(64),
  venueId: z.string().min(1).max(128),
  kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']),
  midKind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
  mid: decimalString.nullable(),
  book: z
    .object({
      bidSize: decimalString,
      askSize: decimalString,
    })
    .nullable(),
  quoteSize: decimalString,
  halfSpreadBps: z.number().int().nonnegative(),
  inventorySkewBps: z.number().int(),
  costTerms: sorCostTermsInput,
  kill: omsMmKillInput,
});

const tcaObservationInput = z.object({
  class: z.enum(TCA_BENCHMARK_CLASSES),
  source: z.string().min(1).max(128),
  licensed: z.boolean(),
  venueId: z.string().min(1).max(128).optional(),
  price: decimalString.optional(),
  bid: decimalString.optional(),
  ask: decimalString.optional(),
  capturedAt: z.string().min(1).max(64).optional(),
  checksum: z.string().min(1).max(128).optional(),
  windowFrom: z.string().min(1).max(64).optional(),
  windowTo: z.string().min(1).max(64).optional(),
  prints: z
    .array(
      z.object({
        price: decimalString,
        amount: decimalString.optional(),
        at: z.string().min(1).max(64).optional(),
      }),
    )
    .max(512)
    .optional(),
});

const omsTcaRunInput = z
  .object({
    parentClientOrderId: z.string().min(1).max(200).optional(),
    clientOrderId: z.string().min(1).max(200).optional(),
    executionGroupId: z.string().min(1).max(200).optional(),
    account: z.string().min(1).max(128).optional(),
    instrument: z.string().min(1).max(64).optional(),
    mandateVersion: z.string().min(1).max(128).optional(),
    decisionAt: z.string().min(1).max(64).optional(),
    arrivalAt: z.string().min(1).max(64).optional(),
    venueUniverse: z.array(z.string().min(1).max(128)).max(32).optional(),
    excludedVenues: z.array(z.string().min(1).max(128)).max(32).optional(),
    entitlements: z
      .object({
        licensedSources: z.array(z.string().min(1).max(128)).max(32).optional(),
        licensedClasses: z.array(z.enum(TCA_BENCHMARK_CLASSES)).max(16).optional(),
      })
      .optional(),
    observations: z.array(tcaObservationInput).max(16).optional(),
  })
  .refine(
    (input) => Boolean(input.parentClientOrderId || input.clientOrderId || input.executionGroupId),
    'parentClientOrderId, clientOrderId, or executionGroupId is required',
  );

const omsMmHedgeInput = z.object({
  symbol: z.string().min(1).max(64),
  quoteVenueId: z.string().min(1).max(128),
  inventory: omsMmInventoryInput,
  kill: omsMmKillInput,
  hedge: z.object({
    venueId: z.string().min(1).max(128),
    kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']),
    midKind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
    mid: decimalString.nullable(),
    costTerms: sorCostTermsInput,
    availableSize: decimalString,
  }),
});

export type ExecutionSubmitMap = Readonly<Record<string, OmsSubmitFn>>;
export type ExecutionCancelMap = Readonly<Record<string, OmsCancelFn>>;
export type ExecutionFetchMap = Readonly<Record<string, OmsFetchFn>>;
export type ExecutionOpenOrdersMap = Readonly<Record<string, OmsOpenOrdersFn>>;
export type ExecutionBalancesMap = Readonly<Record<string, OmsBalancesFn>>;
export type ExecutionPositionsMap = Readonly<Record<string, OmsPositionsFn>>;
export type ExecutionRailsMap = Readonly<Record<string, OmsRailsFn>>;
export type ExecutionFundingMap = Readonly<Record<string, OmsFundingFn>>;
export type ExecutionBorrowMap = Readonly<Record<string, OmsBorrowFn>>;
export type ExecutionLatencyMap = Readonly<Record<string, OmsLatencyFn>>;
export type ExecutionMarketsMap = Readonly<Record<string, OmsMarketsFn>>;
export type ExecutionSnapshotMap = Readonly<Record<string, OmsSnapshotFn>>;

export function createExecutionRouter(
  registry: SealedHouseTenantRegistry,
  submitByVenue: ExecutionSubmitMap = {},
  cancelByVenue: ExecutionCancelMap = {},
  fetchByVenue: ExecutionFetchMap = {},
  openOrdersByVenue: ExecutionOpenOrdersMap = {},
  balancesByVenue: ExecutionBalancesMap = {},
  positionsByVenue: ExecutionPositionsMap = {},
  railsByVenue: ExecutionRailsMap = {},
  fundingByVenue: ExecutionFundingMap = {},
  borrowByVenue: ExecutionBorrowMap = {},
  latencyByVenue: ExecutionLatencyMap = {},
  marketsByVenue: ExecutionMarketsMap = {},
  snapshotByVenue: ExecutionSnapshotMap = {},
  emsStore?: EmsOrderStore,
  captureLake?: CaptureLake,
  pauseStore: AlgoPauseStore = new InMemoryAlgoPauseStore(),
  parentStore: ApprovedAlgoParentStore = new InMemoryApprovedAlgoParentStore(),
  algoJobs: AlgoJobsGate = { enabled: false },
  paper: { enabled: boolean } | undefined = { enabled: false },
  fillConfirmStore: FillConfirmStore | undefined = new InMemoryFillConfirmStore(),
  manualFillStore: ManualFillStore | undefined = new InMemoryManualFillStore(),
  fillAssignStore: FillAssignStore | undefined = new InMemoryFillAssignStore(),
  matchingVenueHalt: MatchingVenueHaltPort = undefined,
  matchingUrl: string | null | undefined = undefined,
  fetchImpl: typeof fetch | undefined = undefined,
  operatorApprovals?: { consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> },
  matchingS2s?: OmsMatchingS2s,
  /** CB-execution-06: market inputs for the customer opportunity read. None wired: NotConnected `feed.market`. */
  arbOpportunityFeed?: ArbOpportunityFeed,
) {
  const haltIdem = new Map<string, { fingerprint: string; value: unknown }>();
  const deskFail = (err: unknown): never => {
    if (err instanceof OperatorDeskError) {
      throw new TRPCError({
        code: err.code === EXECUTION_IDEMPOTENCY_CONFLICT ? 'CONFLICT' : 'PRECONDITION_FAILED',
        message: `${err.code} — ${err.message}`,
        cause: err,
      });
    }
    throw err;
  };
  return router({
    execution: router({
      ops: router({
        inFlight: scopedProcedure('admin:read', { module: 'execution' }).query(() => {
          if (!emsStore) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `${EXECUTION_EMS_STORE_UNWIRED} — the EMS journal is not wired, so in-flight children are not listed`,
            });
          }
          return { asOf: new Date().toISOString(), children: inFlightChildren(emsStore.list()) };
        }),
        halt: scopedProcedure('admin:write', { module: 'execution' })
          .input(
            z.object({
              account: z.string().optional(),
              session: z.string().optional(),
              approvalId: z.string(),
              operationId: z.string(),
              idempotencyKey: z.string(),
            }),
          )
          .mutation(async ({ ctx, input }) => {
            try {
              requireMfa(ctx.principal);
            } catch (err) {
              if (err instanceof AuthError && err.code === 'mfa.required') {
                throw new TRPCError({ code: 'UNAUTHORIZED', message: `${err.code} — ${err.message}`, cause: err });
              }
              throw err;
            }
            try {
              if (!emsStore) {
                throw new OperatorDeskError('EMS evidence store is required for operator halt', EXECUTION_EMS_STORE_UNWIRED);
              }
              const key = assertIdempotencyKey(input.idempotencyKey);
              const scope = haltScope(input);
              const fingerprint = JSON.stringify({
                ...scope,
                approvalId: input.approvalId,
                operationId: input.operationId,
              });
              const prior = haltIdem.get(key);
              if (prior && prior.fingerprint !== fingerprint) {
                throw new OperatorDeskError('This idempotency key was already used for a different halt', EXECUTION_IDEMPOTENCY_CONFLICT);
              }
              if (prior) return prior.value;
              const consumed = await consumeExecutionHalt(operatorApprovals, {
                approvalId: input.approvalId,
                operationId: input.operationId,
                targetId: scope.targetId,
                requesterId: ctx.principal.userId,
              });
              const result = await killInFlightExecution({
                account: scope.account,
                session: scope.session,
                cancelByVenue,
                emsStore,
              });
              if (!result.ok) {
                throw new OperatorDeskError(result.detail, `execution.${result.reason}`);
              }
              const value = {
                ok: true as const,
                scope: result.scope,
                children: result.children,
                approverId: consumed.approverId ?? null,
              };
              haltIdem.set(key, { fingerprint, value });
              return value;
            } catch (err) {
              deskFail(err);
            }
          }),
      }),
      tenant: router({
        describe: scopedProcedure('admin:read', { module: 'execution' })
          .input(tenantIdInput)
          .output(describeOutput)
          .query(async ({ input }) => {
            return withExecutionSpan('execution.tenant.describe', input.tenantId, async () => {
              const result = registry.describe(input.tenantId);
              if (isRefusal(result)) return result;
              return result;
            });
          }),

        kill: omsWriteProcedure.input(tenantIdInput).mutation(async ({ ctx, input }) => {
          return withExecutionSpan('execution.tenant.kill', input.tenantId, async () => {
            const actor = ctx.principal?.userId ?? OMS_WRITE_CALLER;
            const existing = registry.get(input.tenantId);
            if (!existing) {
              const created = registry.register(input.tenantId, actor);
              if ('ok' in created && created.ok === false) {
                throw new TRPCError({ code: 'BAD_REQUEST', message: created.detail });
              }
            }
            const result = registry.kill(input.tenantId, actor);
            if ('ok' in result && result.ok === false) {
              throw new TRPCError({ code: 'NOT_FOUND', message: result.detail });
            }
            return result;
          });
        }),
      }),

      oms: router({
        plan: omsWriteProcedure.input(omsPlanInput).mutation(async ({ ctx, input }) => {
          return withExecutionSpan('execution.oms.plan', input.tenantId ?? 'none', async () => {
            return planOmsRoute(
              {
                symbol: input.symbol,
                side: input.side,
                amount: input.amount,
                venues: input.venues,
                tenantId: input.tenantId,
                actor: ctx.principal?.userId,
              },
              registry,
            );
          });
        }),

        execute: omsWriteProcedure.input(omsPlanInput).mutation(async ({ ctx, input }) => {
          return withExecutionSpan('execution.oms.execute', input.tenantId ?? 'none', async () => {
            return executeOmsRoute(
              {
                symbol: input.symbol,
                side: input.side,
                amount: input.amount,
                venues: input.venues,
                tenantId: input.tenantId,
                actor: ctx.principal?.userId,
                parentClientOrderId: input.parentClientOrderId,
                executionGroupId: input.executionGroupId,
                idempotencyKey: input.idempotencyKey,
                submitByVenue,
                emsStore,
                pauseStore,
              },
              registry,
            );
          });
        }),

        cancel: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              symbol: z.string().min(1).max(64),
              clientOrderId: z.string().min(1).max(128),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
            }),
          )
          .mutation(async ({ input }) => {
            return withExecutionSpan('execution.oms.cancel', input.venueId, async () => {
              return cancelOmsOrder({
                venueId: input.venueId,
                symbol: input.symbol,
                clientOrderId: input.clientOrderId,
                kind: input.kind,
                cancelByVenue,
                emsStore,
              });
            });
          }),

        kill: omsWriteProcedure
          .input(
            z.object({
              account: z.string().min(1).max(128).optional(),
              session: z.string().min(1).max(128).optional(),
            }),
          )
          .mutation(async ({ input }) => {
            return withExecutionSpan('execution.oms.kill', input.account ?? input.session ?? 'none', async () => {
              return killInFlightExecution({
                account: input.account,
                session: input.session,
                cancelByVenue,
                emsStore,
              });
            });
          }),

        drain: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().min(1).max(128).optional(),
              executionGroupId: z.string().min(1).max(128).optional(),
            }),
          )
          .mutation(async ({ input }) => {
            return withExecutionSpan('execution.oms.drain', input.parentClientOrderId ?? input.executionGroupId ?? 'none', async () => {
              return drainInFlightAlgo({
                parentClientOrderId: input.parentClientOrderId,
                executionGroupId: input.executionGroupId,
                cancelByVenue,
                emsStore,
              });
            });
          }),

        cancelRemaining: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().min(1).max(128),
            }),
          )
          .mutation(async ({ input }) => {
            return withExecutionSpan('execution.oms.cancelRemaining', input.parentClientOrderId, async () => {
              return cancelRemainingParentChildren({
                parentClientOrderId: input.parentClientOrderId,
                cancelByVenue,
                emsStore,
              });
            });
          }),

        attribute: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().min(1).max(128),
            }),
          )
          .mutation(async ({ input }) => {
            return withExecutionSpan('execution.oms.attribute', input.parentClientOrderId, async () => {
              return attributeChildFillsToParent({
                parentClientOrderId: input.parentClientOrderId,
                emsStore,
              });
            });
          }),

        repairHedge: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().min(1).max(200),
              clientOrderId: z.string().min(1).max(200),
            }),
          )
          .mutation(async ({ input }) => {
            return withExecutionSpan('execution.oms.repairHedge', input.clientOrderId, async () => {
              return repairFailedHedgeChild({
                parentClientOrderId: input.parentClientOrderId,
                clientOrderId: input.clientOrderId,
                emsStore,
              });
            });
          }),

        retryHedge: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().min(1).max(200),
              clientOrderId: z.string().min(1).max(200),
            }),
          )
          .mutation(async ({ input }) => {
            return withExecutionSpan('execution.oms.retryHedge', input.clientOrderId, async () => {
              return retryFailedHedgeChild({
                parentClientOrderId: input.parentClientOrderId,
                clientOrderId: input.clientOrderId,
                parentStore,
                emsStore,
              });
            });
          }),

        failedHedges: scopedProcedure('admin:read', { module: 'execution' })
          .input(z.object({ parentClientOrderId: z.string().max(200).optional() }))
          .query(async ({ input }) =>
            withExecutionSpan('execution.oms.failedHedges', input.parentClientOrderId ?? 'none', async () =>
              listFailedHedgeChildren({
                parentClientOrderId: input.parentClientOrderId,
                parentStore,
                emsStore,
              }),
            ),
          ),

        pause: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().min(1).max(128).optional(),
              executionGroupId: z.string().min(1).max(128).optional(),
            }),
          )
          .mutation(async ({ input }) => {
            return withExecutionSpan('execution.oms.pause', input.parentClientOrderId ?? input.executionGroupId ?? 'none', async () => {
              return pauseInFlightAlgo({
                parentClientOrderId: input.parentClientOrderId,
                executionGroupId: input.executionGroupId,
                emsStore,
                pauseStore,
              });
            });
          }),

        resume: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().min(1).max(128).optional(),
              executionGroupId: z.string().min(1).max(128).optional(),
            }),
          )
          .mutation(async ({ input }) => {
            return withExecutionSpan('execution.oms.resume', input.parentClientOrderId ?? input.executionGroupId ?? 'none', async () => {
              return resumeInFlightAlgo({
                parentClientOrderId: input.parentClientOrderId,
                executionGroupId: input.executionGroupId,
                emsStore,
                pauseStore,
              });
            });
          }),

        approve: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().min(1).max(200),
              kind: z.enum(['twap', 'vwap', 'pov']).optional(),
              schedule: z
                .object({
                  durationMs: z.number().int().positive(),
                  sliceIntervalMs: z.number().int().positive(),
                  slicesPlanned: z.number().int().positive(),
                  participationBps: z.number().int().nullable(),
                })
                .optional(),
            }),
          )
          .mutation(async ({ ctx, input }) => {
            return withExecutionSpan('execution.oms.approve', input.parentClientOrderId, async () => {
              return approveAlgoParent({
                parentClientOrderId: input.parentClientOrderId,
                kind: input.kind,
                schedule: input.schedule,
                operatorId: ctx.principal?.userId,
                parentStore,
                jobs: algoJobs,
                matchingVenueHalt: await resolveMatchingVenueHalt(matchingVenueHalt),
              });
            });
          }),

        start: omsWriteProcedure.input(z.object({ parentClientOrderId: z.string().min(1).max(200) })).mutation(async ({ ctx, input }) => {
          return withExecutionSpan('execution.oms.start', input.parentClientOrderId, async () => {
            return startApprovedAlgoParent({
              parentClientOrderId: input.parentClientOrderId,
              operatorId: ctx.principal?.userId,
              parentStore,
              jobs: algoJobs,
              matchingVenueHalt: await resolveMatchingVenueHalt(matchingVenueHalt),
            });
          });
        }),

        startBasket: omsWriteProcedure.input(omsStartBasketInput).mutation(async ({ ctx, input }) => {
          return withExecutionSpan('execution.oms.startBasket', input.parentClientOrderId ?? 'none', async () => {
            return handleStartBasketDoor(input, ctx.principal?.userId, {
              jobs: algoJobs,
              matchingVenueHalt,
              matchingUrl,
              fetch: fetchImpl,
              matchingS2s,
            });
          });
        }),

        killBasket: omsWriteProcedure.input(omsKillBasketInput).mutation(async ({ input }) => {
          return withExecutionSpan('execution.oms.killBasket', 'basket', async () => {
            return handleKillBasketDoor(input, {
              matchingUrl,
              fetch: fetchImpl,
              matchingS2s,
            });
          });
        }),

        stop: omsWriteProcedure.input(z.object({ parentClientOrderId: z.string().min(1).max(200) })).mutation(async ({ input }) => {
          return withExecutionSpan('execution.oms.stop', input.parentClientOrderId, async () => {
            return stopRunningAlgoParent({
              parentClientOrderId: input.parentClientOrderId,
              parentStore,
              pauseStore,
              emsStore,
            });
          });
        }),

        undeploy: omsWriteProcedure.input(z.object({ parentClientOrderId: z.string().min(1).max(200) })).mutation(async ({ input }) => {
          return withExecutionSpan('execution.oms.undeploy', input.parentClientOrderId, async () => {
            return undeployStoppedAlgoParent({
              parentClientOrderId: input.parentClientOrderId,
              parentStore,
              emsStore,
            });
          });
        }),

        liveChildren: scopedProcedure('admin:read', { module: 'execution' })
          .input(z.object({ parentClientOrderId: z.string().max(200).optional() }))
          .query(async ({ input }) =>
            withExecutionSpan('execution.oms.liveChildren', input.parentClientOrderId ?? 'none', async () =>
              listLiveEmsChildren({
                parentClientOrderId: input.parentClientOrderId,
                parentStore,
                emsStore,
              }),
            ),
          ),

        undeployDrain: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().min(1).max(200) }))
          .mutation(async ({ input }) => {
            return withExecutionSpan('execution.oms.undeployDrain', input.parentClientOrderId, async () => {
              return undeployDrainStoppedAlgoParent({
                parentClientOrderId: input.parentClientOrderId,
                parentStore,
                emsStore,
                cancelByVenue,
              });
            });
          }),

        expire: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().min(1).max(200) }))
          .mutation(async ({ input }) =>
            withExecutionSpan('execution.oms.expire', input.parentClientOrderId, async () =>
              expireAlgoParent({ parentClientOrderId: input.parentClientOrderId, parentStore }),
            ),
          ),

        releaseResidual: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().min(1).max(200) }))
          .mutation(async ({ input }) =>
            withExecutionSpan('execution.oms.releaseResidual', input.parentClientOrderId, async () =>
              releaseExpiredParentResidual({ parentClientOrderId: input.parentClientOrderId, parentStore, emsStore }),
            ),
          ),

        paper: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().min(1).max(200) }))
          .mutation(async ({ input }) =>
            withExecutionSpan('execution.oms.paper', input.parentClientOrderId, async () =>
              paperRunAlgoParent({ parentClientOrderId: input.parentClientOrderId, parentStore, paper }),
            ),
          ),

        promote: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().min(1).max(200) }))
          .mutation(async ({ input }) =>
            withExecutionSpan('execution.oms.promote', input.parentClientOrderId, async () =>
              promotePaperParentToLive({ parentClientOrderId: input.parentClientOrderId, parentStore, jobs: algoJobs }),
            ),
          ),

        stage: omsWriteProcedure.input(z.object({ parentClientOrderId: z.string().max(200).optional() })).mutation(async ({ ctx, input }) =>
          withExecutionSpan('execution.oms.stage', input.parentClientOrderId ?? 'none', async () =>
            stageApprovedParent({
              parentClientOrderId: input.parentClientOrderId,
              operatorId: ctx.principal?.userId,
              parentStore,
            }),
          ),
        ),

        release: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().max(200).optional() }))
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.release', input.parentClientOrderId ?? 'none', async () =>
              releaseStagedParentToLive({
                parentClientOrderId: input.parentClientOrderId,
                operatorId: ctx.principal?.userId,
                parentStore,
                matchingVenueHalt: await resolveMatchingVenueHalt(matchingVenueHalt),
              }),
            ),
          ),

        abandon: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().max(200).optional() }))
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.abandon', input.parentClientOrderId ?? 'none', async () =>
              abandonStagedParent({
                parentClientOrderId: input.parentClientOrderId,
                operatorId: ctx.principal?.userId,
                parentStore,
              }),
            ),
          ),

        slice: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              amount: z.string().max(64).optional(),
              venueId: z.string().max(128).optional(),
              symbol: z.string().max(64).optional(),
              side: z.enum(['buy', 'sell']).optional(),
              limitPrice: z.string().max(64).optional(),
              parentCap: z.string().max(64).optional(),
            }),
          )
          .mutation(async ({ input }) =>
            withExecutionSpan('execution.oms.slice', input.parentClientOrderId ?? 'none', async () =>
              sliceLiveAlgoParent({
                parentClientOrderId: input.parentClientOrderId,
                amount: input.amount,
                venueId: input.venueId,
                symbol: input.symbol,
                side: input.side,
                limitPrice: input.limitPrice,
                parentCap: input.parentCap,
                parentStore,
                submitByVenue,
                pauseStore,
                emsStore,
              }),
            ),
          ),

        scheduleSlice: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              amount: z.string().max(64).optional(),
              venueId: z.string().max(128).optional(),
              symbol: z.string().max(64).optional(),
              side: z.enum(['buy', 'sell']).optional(),
              limitPrice: z.string().max(64).optional(),
              parentCap: z.string().max(64).optional(),
              now: z.coerce.date().optional(),
            }),
          )
          .mutation(async ({ input }) =>
            withExecutionSpan('execution.oms.scheduleSlice', input.parentClientOrderId ?? 'none', async () =>
              scheduleSliceLiveAlgoParent({
                parentClientOrderId: input.parentClientOrderId,
                amount: input.amount,
                venueId: input.venueId,
                symbol: input.symbol,
                side: input.side,
                limitPrice: input.limitPrice,
                parentCap: input.parentCap,
                now: input.now,
                parentStore,
                submitByVenue,
                pauseStore,
                emsStore,
              }),
            ),
          ),

        ownership: scopedProcedure('admin:read', { module: 'execution' })
          .input(z.object({ parentClientOrderId: z.string().max(200).optional() }))
          .query(async ({ input }) =>
            withExecutionSpan('execution.oms.ownership', input.parentClientOrderId ?? 'none', async () =>
              readLiveAlgoParentOwnership({
                parentClientOrderId: input.parentClientOrderId,
                parentStore,
              }),
            ),
          ),

        unattended: scopedProcedure('admin:read', { module: 'execution' })
          .input(
            z.object({
              /**
               * Page size. Optional so omit reaches the named refuse
               * (`execution.unattended_list_limit_unset`) instead of a Zod "Required".
               * Blank is not 50; pass 50 explicitly when that is the page you want.
               */
              limit: z.number().int().min(1).max(200).optional(),
            }),
          )
          .query(async ({ input }) => {
            let limit: number;
            try {
              limit = assertUnattendedListLimit(input.limit);
            } catch (err) {
              if (err instanceof UnattendedListLimitUnsetError) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message: err.message,
                  cause: err,
                });
              }
              throw err;
            }
            return withExecutionSpan('execution.oms.unattended', 'desk', async () => {
              const out = listUnattendedLiveParents({ parentStore });
              if (!out.ok) return out;
              return { ok: true as const, parents: out.parents.slice(0, limit) };
            });
          }),

        killUnattended: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().max(200).optional() }))
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.killUnattended', input.parentClientOrderId ?? 'none', async () =>
              killUnattendedLiveParent({
                parentClientOrderId: input.parentClientOrderId,
                operatorId: ctx.principal?.userId,
                parentStore,
                pauseStore,
                emsStore,
                cancelByVenue,
              }),
            ),
          ),

        killParent: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              paper: z.boolean().optional(),
              kind: z.string().max(64).optional(),
              children: z
                .array(
                  z.object({
                    marketId: z.string().max(128).optional().nullable(),
                    orderId: z.string().max(200).optional().nullable(),
                  }),
                )
                .max(32)
                .optional(),
            }),
          )
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.killParent', input.parentClientOrderId ?? 'none', async () =>
              handleKillParentDoor(input, ctx.principal?.userId, {
                parentStore,
                pauseStore,
                emsStore,
                cancelByVenue,
                matchingUrl,
                fetch: fetchImpl,
                matchingS2s,
              }),
            ),
          ),

        claim: omsWriteProcedure.input(z.object({ parentClientOrderId: z.string().max(200).optional() })).mutation(async ({ ctx, input }) =>
          withExecutionSpan('execution.oms.claim', input.parentClientOrderId ?? 'none', async () =>
            claimLiveAlgoParent({
              parentClientOrderId: input.parentClientOrderId,
              operatorId: ctx.principal?.userId,
              parentStore,
            }),
          ),
        ),

        unclaim: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().max(200).optional() }))
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.unclaim', input.parentClientOrderId ?? 'none', async () =>
              unclaimLiveAlgoParent({
                parentClientOrderId: input.parentClientOrderId,
                operatorId: ctx.principal?.userId,
                parentStore,
              }),
            ),
          ),

        pass: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              targetOperatorId: z.string().max(200).optional(),
              expireAt: z.string().max(64).optional(),
            }),
          )
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.pass', input.parentClientOrderId ?? 'none', async () =>
              passLiveAlgoParent({
                parentClientOrderId: input.parentClientOrderId,
                operatorId: ctx.principal?.userId,
                targetOperatorId: input.targetOperatorId,
                expireAt: input.expireAt,
                parentStore,
                emsStore,
                fillConfirmStore,
              }),
            ),
          ),

        accept: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().max(200).optional() }))
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.accept', input.parentClientOrderId ?? 'none', async () =>
              acceptLiveAlgoParentPass({
                parentClientOrderId: input.parentClientOrderId,
                operatorId: ctx.principal?.userId,
                parentStore,
                emsStore,
                fillConfirmStore,
              }),
            ),
          ),

        reject: omsWriteProcedure
          .input(z.object({ parentClientOrderId: z.string().max(200).optional() }))
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.reject', input.parentClientOrderId ?? 'none', async () =>
              rejectLiveAlgoParentPass({
                parentClientOrderId: input.parentClientOrderId,
                operatorId: ctx.principal?.userId,
                parentStore,
              }),
            ),
          ),

        timeoutPass: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              now: z.coerce.date().optional(),
            }),
          )
          .mutation(async ({ input }) =>
            withExecutionSpan('execution.oms.timeoutPass', input.parentClientOrderId ?? 'none', async () =>
              timeoutLiveAlgoParentPass({
                parentClientOrderId: input.parentClientOrderId,
                parentStore,
                now: input.now,
              }),
            ),
          ),

        shift: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              incomingOperatorId: z.string().max(200).optional(),
            }),
          )
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.shift', input.parentClientOrderId ?? 'none', async () =>
              shiftLiveAlgoParent({
                parentClientOrderId: input.parentClientOrderId,
                operatorId: ctx.principal?.userId,
                incomingOperatorId: input.incomingOperatorId,
                parentStore,
                emsStore,
                fillConfirmStore,
              }),
            ),
          ),

        fill: scopedProcedure('admin:read', { module: 'execution' })
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              clientOrderId: z.string().max(200).optional(),
            }),
          )
          .query(async ({ input }) =>
            withExecutionSpan('execution.oms.fill', input.clientOrderId ?? input.parentClientOrderId ?? 'none', async () =>
              readChildFillConfirmation({
                parentClientOrderId: input.parentClientOrderId,
                clientOrderId: input.clientOrderId,
                parentStore,
                emsStore,
                fillConfirmStore,
              }),
            ),
          ),

        unconfirmed: scopedProcedure('admin:read', { module: 'execution' })
          .input(z.object({ parentClientOrderId: z.string().max(200).optional() }))
          .query(async ({ input }) =>
            withExecutionSpan('execution.oms.unconfirmed', input.parentClientOrderId ?? 'none', async () =>
              listUnconfirmedChildFills({
                parentClientOrderId: input.parentClientOrderId,
                parentStore,
                emsStore,
                fillConfirmStore,
              }),
            ),
          ),

        orphaned: scopedProcedure('admin:read', { module: 'execution' })
          .input(
            z.object({
              /**
               * Page size. Optional so omit reaches the named refuse
               * (`execution.orphaned_list_limit_unset`) instead of a Zod "Required".
               * Blank is not 50; pass 50 explicitly when that is the page you want.
               */
              limit: z.number().int().min(1).max(200).optional(),
            }),
          )
          .query(async ({ input }) => {
            let limit: number;
            try {
              limit = assertOrphanedListLimit(input.limit);
            } catch (err) {
              if (err instanceof OrphanedListLimitUnsetError) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message: err.message,
                  cause: err,
                });
              }
              throw err;
            }
            return withExecutionSpan('execution.oms.orphaned', 'desk', async () => {
              const out = listOrphanedChildFills({ parentStore, emsStore });
              if (!out.ok) return out;
              return { ok: true as const, fills: out.fills.slice(0, limit) };
            });
          }),

        assignFill: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              clientOrderId: z.string().max(200).optional(),
              accountTag: z.string().max(200).optional(),
            }),
          )
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.assignFill', input.clientOrderId ?? input.parentClientOrderId ?? 'none', async () => {
              const accountTag = input.accountTag?.trim() ?? '';
              if (accountTag) {
                return assignChildFill({
                  parentClientOrderId: input.parentClientOrderId,
                  clientOrderId: input.clientOrderId,
                  accountTag,
                  operatorId: ctx.principal?.userId,
                  parentStore,
                  emsStore,
                  fillAssignStore,
                });
              }
              return assignOrphanedChildFill({
                parentClientOrderId: input.parentClientOrderId,
                clientOrderId: input.clientOrderId,
                operatorId: ctx.principal?.userId,
                parentStore,
                emsStore,
              });
            }),
          ),

        confirmFill: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              clientOrderId: z.string().max(200).optional(),
            }),
          )
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.confirmFill', input.clientOrderId ?? input.parentClientOrderId ?? 'none', async () =>
              confirmChildFill({
                parentClientOrderId: input.parentClientOrderId,
                clientOrderId: input.clientOrderId,
                confirmerId: ctx.principal?.userId,
                parentStore,
                emsStore,
                fillConfirmStore,
              }),
            ),
          ),

        manualFill: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              clientOrderId: z.string().max(200).optional(),
              amount: z.string().max(64).optional(),
              price: z.string().max(64).optional(),
              side: z.enum(['buy', 'sell']).optional(),
              parentCap: z.string().max(64).optional(),
            }),
          )
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.manualFill', input.clientOrderId ?? input.parentClientOrderId ?? 'none', async () =>
              recordManualChildFill({
                parentClientOrderId: input.parentClientOrderId,
                clientOrderId: input.clientOrderId,
                amount: input.amount,
                price: input.price,
                side: input.side,
                parentCap: input.parentCap,
                confirmerId: ctx.principal?.userId,
                parentStore,
                manualFillStore,
              }),
            ),
          ),

        correctFill: omsWriteProcedure
          .input(
            z.object({
              parentClientOrderId: z.string().max(200).optional(),
              clientOrderId: z.string().max(200).optional(),
              accountTag: z.string().max(200).optional(),
              amount: z.string().max(64).optional(),
              price: z.string().max(64).optional(),
            }),
          )
          .mutation(async ({ ctx, input }) =>
            withExecutionSpan('execution.oms.correctFill', input.clientOrderId ?? input.parentClientOrderId ?? 'none', async () =>
              correctChildFill({
                parentClientOrderId: input.parentClientOrderId,
                clientOrderId: input.clientOrderId,
                accountTag: input.accountTag,
                amount: input.amount,
                price: input.price,
                operatorId: ctx.principal?.userId,
                parentStore,
                emsStore,
                fillAssignStore,
              }),
            ),
          ),

        fetch: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              symbol: z.string().min(1).max(64),
              clientOrderId: z.string().min(1).max(128),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
            }),
          )
          .query(async ({ input }) => {
            return withExecutionSpan('execution.oms.fetch', input.venueId, async () => {
              return fetchOmsOrder({
                venueId: input.venueId,
                symbol: input.symbol,
                clientOrderId: input.clientOrderId,
                kind: input.kind,
                fetchByVenue,
                emsStore,
              });
            });
          }),

        openOrders: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              symbol: z.string().min(1).max(64).optional(),
              side: z.enum(['buy', 'sell']).optional(),
              type: z.enum(['limit', 'market']).optional(),
              clientOrderId: z.string().min(1).max(128).optional(),
              venueOrderId: z.string().min(1).max(128).optional(),
              feeAsset: z.string().min(1).max(32).optional(),
              status: z.enum(['open', 'partially_filled']).optional(),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
            }),
          )
          .query(async ({ input }) => {
            return withExecutionSpan('execution.oms.openOrders', input.venueId, async () => {
              return listOmsOpenOrders({
                venueId: input.venueId,
                symbol: input.symbol,
                side: input.side,
                type: input.type,
                clientOrderId: input.clientOrderId,
                venueOrderId: input.venueOrderId,
                feeAsset: input.feeAsset,
                status: input.status,
                kind: input.kind,
                openOrdersByVenue,
              });
            });
          }),

        balances: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              asset: z.string().min(1).max(32).optional(),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
            }),
          )
          .query(async ({ input }) => {
            return withExecutionSpan('execution.oms.balances', input.venueId, async () => {
              return observeOmsBalances({
                venueId: input.venueId,
                asset: input.asset,
                kind: input.kind,
                balancesByVenue,
              });
            });
          }),

        positions: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              symbol: z.string().min(1).max(64).optional(),
              side: z.enum(['long', 'short']).optional(),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
            }),
          )
          .query(async ({ input }) => {
            return withExecutionSpan('execution.oms.positions', input.venueId, async () => {
              return observeOmsPositions({
                venueId: input.venueId,
                symbol: input.symbol,
                side: input.side,
                kind: input.kind,
                positionsByVenue,
              });
            });
          }),

        rails: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              asset: z.string().min(1).max(32),
              enabled: z.boolean().optional(),
              network: z.string().min(1).max(32).optional(),
              toVenueId: z.string().min(1).max(128).optional(),
              fromVenueId: z.string().min(1).max(128).optional(),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
            }),
          )
          .query(async ({ input }) => {
            return withExecutionSpan('execution.oms.rails', input.venueId, async () => {
              return observeOmsRails({
                venueId: input.venueId,
                asset: input.asset,
                enabled: input.enabled,
                network: input.network,
                toVenueId: input.toVenueId,
                fromVenueId: input.fromVenueId,
                kind: input.kind,
                railsByVenue,
              });
            });
          }),

        funding: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              symbol: z.string().min(1).max(64),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
            }),
          )
          .query(async ({ input }) => {
            return withExecutionSpan('execution.oms.funding', input.venueId, async () => {
              return observeOmsFunding({
                venueId: input.venueId,
                symbol: input.symbol,
                kind: input.kind,
                fundingByVenue,
              });
            });
          }),

        borrow: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              asset: z.string().min(1).max(32),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
            }),
          )
          .query(async ({ input }) => {
            return withExecutionSpan('execution.oms.borrow', input.venueId, async () => {
              return observeOmsBorrow({
                venueId: input.venueId,
                asset: input.asset,
                kind: input.kind,
                borrowByVenue,
              });
            });
          }),

        latency: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
              now: z.coerce.date().optional(),
            }),
          )
          .query(async ({ input }) => {
            return withExecutionSpan('execution.oms.latency', input.venueId, async () => {
              return observeOmsLatency({
                venueId: input.venueId,
                kind: input.kind,
                now: input.now,
                latencyByVenue,
              });
            });
          }),

        markets: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              type: z.enum(['spot', 'perpetual', 'future', 'option', 'margin', 'fx', 'cfd']).optional(),
              quote: z.string().min(1).max(32).optional(),
              base: z.string().min(1).max(32).optional(),
              active: z.boolean().optional(),
              settle: z.string().min(1).max(32).optional(),
              symbol: z.string().min(1).max(64).optional(),
              venueSymbol: z.string().min(1).max(64).optional(),
              expiry: z.coerce.date().optional(),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
            }),
          )
          .query(async ({ input }) => {
            return withExecutionSpan('execution.oms.markets', input.venueId, async () => {
              return observeOmsMarkets({
                venueId: input.venueId,
                type: input.type,
                quote: input.quote,
                base: input.base,
                active: input.active,
                settle: input.settle,
                symbol: input.symbol,
                venueSymbol: input.venueSymbol,
                expiry: input.expiry,
                kind: input.kind,
                marketsByVenue,
              });
            });
          }),

        snapshot: omsWriteProcedure
          .input(
            z.object({
              venueId: z.string().min(1).max(128),
              symbol: z.string().min(1).max(64),
              limit: z.number().int().positive().max(1000).optional(),
              kind: z.enum(['internal', 'external-cex', 'external-dex', 'amm', 'otc']).optional(),
            }),
          )
          .query(async ({ input }) => {
            return withExecutionSpan('execution.oms.snapshot', input.venueId, async () => {
              return observeOmsSnapshot({
                venueId: input.venueId,
                symbol: input.symbol,
                limit: input.limit,
                kind: input.kind,
                snapshotByVenue,
              });
            });
          }),

        tca: router({
          run: scopedProcedure('admin:read', { module: 'execution' })
            .input(omsTcaRunInput)
            .query(async ({ input }) => {
              if (!emsStore) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'EMS store is not wired on this host' });
              }
              const spanId = input.parentClientOrderId ?? input.clientOrderId ?? input.executionGroupId ?? 'tca';
              return withExecutionSpan('execution.oms.tca.run', spanId, async () =>
                runTcaRun({
                  parentClientOrderId: input.parentClientOrderId,
                  clientOrderId: input.clientOrderId,
                  executionGroupId: input.executionGroupId,
                  account: input.account,
                  instrument: input.instrument,
                  mandateVersion: input.mandateVersion,
                  decisionAt: input.decisionAt,
                  arrivalAt: input.arrivalAt,
                  venueUniverse: input.venueUniverse,
                  excludedVenues: input.excludedVenues,
                  entitlements: input.entitlements,
                  observations: input.observations,
                  emsStore,
                  captureLake,
                }),
              );
            }),

          parent: scopedProcedure('admin:read', { module: 'execution' })
            .input(z.object({ parentClientOrderId: z.string().min(1).max(200) }))
            .query(async ({ input }) => {
              if (!emsStore) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'EMS store is not wired on this host' });
              }
              return withExecutionSpan('execution.oms.tca.parent', input.parentClientOrderId, async () =>
                runTcaForParent({
                  parentClientOrderId: input.parentClientOrderId,
                  emsStore,
                  captureLake,
                }),
              );
            }),

          markouts: scopedProcedure('admin:read', { module: 'execution' })
            .input(z.object({ parentClientOrderId: z.string().min(1).max(200) }))
            .query(async ({ input }) => {
              if (!emsStore) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'EMS store is not wired on this host' });
              }
              return withExecutionSpan('execution.oms.tca.markouts', input.parentClientOrderId, async () =>
                recordMarkoutsForParent({
                  parentClientOrderId: input.parentClientOrderId,
                  emsStore,
                  captureLake,
                }),
              );
            }),
        }),

        ems: router({
          list: scopedProcedure('admin:read', { module: 'execution' })
            .input(
              z.object({
                venueId: z.string().min(1).max(128).optional(),
                symbol: z.string().min(1).max(64).optional(),
                executionGroupId: z.string().min(1).max(200).optional(),
                parentClientOrderId: z.string().min(1).max(200).optional(),
                state: z.enum(['ACKNOWLEDGED', 'REJECTED', 'UNWIRED', 'SUBMIT_UNKNOWN', 'OUTCOME_UNKNOWN']).optional(),
                reconciliationKey: z.string().min(1).max(300).optional(),
                /**
                 * Page size. Optional so omit reaches the named refuse
                 * (`execution.ems_list_limit_unset`) instead of a Zod "Required".
                 * Blank is not 50; pass 50 explicitly when that is the page you want.
                 */
                limit: z.number().int().min(1).max(200).optional(),
              }),
            )
            .query(async ({ input }) => {
              if (!emsStore) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'EMS store is not wired on this host' });
              }
              let limit: number;
              try {
                limit = assertEmsListLimit(input.limit);
              } catch (err) {
                if (err instanceof EmsListLimitUnsetError) {
                  throw new TRPCError({
                    code: 'PRECONDITION_FAILED',
                    message: err.message,
                    cause: err,
                  });
                }
                throw err;
              }
              return withExecutionSpan('execution.oms.ems.list', input.venueId ?? 'all', async () =>
                emsStore
                  .list({
                    venueId: input.venueId,
                    symbol: input.symbol,
                    executionGroupId: input.executionGroupId,
                    parentClientOrderId: input.parentClientOrderId,
                    state: input.state,
                    reconciliationKey: input.reconciliationKey,
                  })
                  .slice(0, limit),
              );
            }),

          get: scopedProcedure('admin:read', { module: 'execution' })
            .input(
              z
                .object({
                  clientOrderId: z.string().min(1).max(200).optional(),
                  reconciliationKey: z.string().min(1).max(300).optional(),
                })
                .refine(
                  (input) => Boolean(input.clientOrderId || input.reconciliationKey),
                  'clientOrderId or reconciliationKey is required',
                ),
            )
            .query(async ({ input }) => {
              if (!emsStore) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'EMS store is not wired on this host' });
              }
              const lookupKey = input.clientOrderId ?? input.reconciliationKey!;
              return withExecutionSpan('execution.oms.ems.get', lookupKey, async () => {
                const row = input.clientOrderId
                  ? emsStore.get(input.clientOrderId)
                  : emsStore.getByReconciliationKey(input.reconciliationKey!);
                if (!row) {
                  throw new TRPCError({ code: 'NOT_FOUND', message: `EMS evidence not found for ${lookupKey}` });
                }
                return row;
              });
            }),
        }),
      }),

      policy: publicProcedure.query(() => describeExecutionSpine()),

      spine: scopedProcedure('admin:read', { module: 'execution' }).query(() => describeExecutionSpine()),

      arb: router({
        /**
         * CB-execution-06: customer read of funding and spread opportunities. Read only: places no order.
         * No feed attached answers NotConnected `feed.market`; blanks come back as refused rows.
         */
        opportunities: scopedProcedure('trade:read')
          .input(z.object({ symbol: z.string().min(1).max(64), amount: decimalString }).strict())
          .query(async ({ input }) =>
            withExecutionSpan('execution.arb.opportunities', input.symbol, async () =>
              readArbOpportunities({ feed: arbOpportunityFeed, symbol: input.symbol, amount: input.amount, nowMs: Date.now() }),
            ),
          ),
        scan: omsWriteProcedure.input(omsArbScanInput).mutation(async ({ input }) => {
          return withExecutionSpan('execution.arb.scan', input.symbol, async () => scanOmsExternalArb(input));
        }),
        planLegs: omsWriteProcedure.input(omsArbPlanLegsInput).mutation(async ({ input }) => {
          return withExecutionSpan('execution.arb.planLegs', input.symbol, async () => planOmsArbAtomicLegs(input));
        }),
        executeLegs: omsWriteProcedure.input(omsArbExecuteLegsInput).mutation(async ({ input }) => {
          return withExecutionSpan('execution.arb.executeLegs', input.symbol, async () =>
            executeOmsArbAtomicLegs(input, submitByVenue, emsStore),
          );
        }),
      }),

      mm: router({
        quote: omsWriteProcedure.input(omsMmQuoteInput).mutation(async ({ input }) => {
          return withExecutionSpan('execution.mm.quote', input.venueId, async () => quoteOmsExternalMm(input));
        }),

        hedge: omsWriteProcedure.input(omsMmHedgeInput).mutation(async ({ input }) => {
          return withExecutionSpan('execution.mm.hedge', input.quoteVenueId, async () => planOmsExternalMmHedge(input));
        }),
      }),
    }),
  });
}

export type ExecutionRouter = ReturnType<typeof createExecutionRouter>;
