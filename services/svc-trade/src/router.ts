import { z } from 'zod';
import { gridRouter } from './grid/router.js';
import type { GridService } from './grid/grid-service.js';
import {
  JurisdictionError,
  mergeRouters,
  router,
  publicProcedure,
  scopedProcedure,
  serviceProcedure,
  TRPCError,
  type Context,
  StepUpCheckError,
} from '@intafaced/contracts';
import { AuthError, requireTier, TIER_ORDER, type Principal } from '@intafaced/auth';
import { checkAccess } from '@intafaced/config';
import { formatAmount, parseAmount, InsufficientFundsError, LedgerError } from '@intafaced/ledger-client';
import { publicLedgerCode, publicLedgerMessage, SETTLEMENT_PENDING } from './ledger-public-code.js';
import { orderSideSchema, timeInForceSchema } from '@intafaced/exchange-contract';
import { TradeError, type FillRecord, type Market, type OrderRecord, type TimeInForce } from './spot/types.js';
import { MatchingNoBookError } from './spot/matching-client.js';
import { assertProductionUnsettledAssetClassListing, forexSettlementStatus } from './spot/forex-settlement.js';
import { fxNamedDegrade } from './spot/fx-product.js';
import {
  FillsMineLimitUnsetError,
  MarketsLimitUnsetError,
  OpenOrdersLimitUnsetError,
  OrderHistoryLimitUnsetError,
  publishedFillsMineLimit,
  publishedOpenOrdersLimit,
  type TradeService,
} from './spot/trade-service.js';
import { otcDeskLawStatusLine, UNPUBLISHED_OTC_DESK_LAW } from './otc/desk-law.js';
import { OTC_DESK_LAW_RESIDUAL, OtcError } from './otc/errors.js';
import { otcMakerRoutingStatus, OTC_MAKER_ROUTING_RESIDUAL } from './otc/maker-routing.js';
import { listOtcMakers, selectOtcMakers, UNPUBLISHED_OTC_MAKER_DIRECTORY } from './otc/maker-directory.js';
import { otcMidFeedStatus, OTC_MID_FEED_RESIDUAL } from './otc/mid-feed.js';
import type { OtcDeskService } from './otc/otc-service.js';
import { copyDetachOutput, copyFlattenOutput, copyPauseOutput, copyResumeOutput, copyStopOutput } from './copy/copy-control-wire.js';
import {
  copyDeskStatusOutput,
  copyOpsStatusOutput,
  presentCopyOpsStatus,
  presentCustomerCopyDesk,
  unmountedCopyDeskFacts,
} from './copy/desk-status.js';
import { COPY_FEE_SHARE_RESIDUAL, COPY_JURISDICTION_RESIDUAL, CopyError } from './copy/errors.js';
import type { LeadDesk } from './copy/lead-applications.js';
import { TradeOpsError } from './admin/common.js';
import { logRefusalSpec } from './refusal-spec-log.js';
import { describeCopyPolicy } from './copy/copy-policy.js';
import { ListMyFollowsLimitUnsetError, publishedListMyFollowsLimit, type CopyService } from './copy/copy-service.js';
import { publishedCopyPageLimit, refuseLeaderDirectoryRanking } from './copy/leader-listing.js';
import { describeFuturesPolicy } from './futures/futures-policy.js';
import { isPremarket } from './futures/premarket.js';
import { describeOptionsPolicy } from './spot/options-policy.js';
import { describeOtcPolicy } from './otc/otc-policy.js';
import { convertHistoryProcedures } from './convert/convert-history-router.js';
import { convertHistoryTrpcError } from './convert/convert-history.js';
import { deskTrpcError } from './desk/errors.js';
import { copyCloseTrpcError } from './copy/copy-close-errors.js';
import { algoDeskProcedures, optionsDeskProcedures, rfqHistoryProcedures, scaleProcedures } from './desk/procedures.js';
import { presentAlgoDesk, presentChase, presentScheduleHonesty } from './algo/present.js';
import { MAX_ALGO_SEED } from './algo/schedule.js';
import { awaitingTrigger, POV_BASES } from './algo/types.js';
import { tradingControlsRouter } from './controls/router.js';
import { TradingControlError, type TradingControls } from './controls/trading-controls.js';
import { tradeOpsAdminRouter } from './admin/router.js';
import { insuranceAdminRouter, type InsuranceTopupAdmin } from './admin/insurance-topup.js';
import { supportTradeSummaryRouter } from './support/router.js';
import type { SupportTradeSummaryReader } from './support/trade-summary.js';
import type { TradeOpsAdmin } from './admin/service.js';
import { ALGO_STOP_REASONS, algoStopReason, type AlgoStopReasonCode } from './algo/stop-reason.js';

/**
 * svc-trade's API (§5.2).
 *
 * Every amount on this boundary is a DECIMAL STRING, in and out. `Amount` is a
 * scaled bigint and bigint does not survive JSON; a JS number would round the
 * 18th decimal place away silently, which is the place the ledger reconciles
 * at. The conversion happens here and nowhere else.
 *
 * Authorisation is declared on the procedure — `scopedProcedure('trade:write',
 * { module: 'trade' })` checks the scope, the verification tier and the
 * jurisdiction matrix in one middleware, so nothing can accidentally skip the
 * matrix. `TradeService` repeats the scope check internally, because a service
 * whose only gate lives in one transport gains a hole the day it gains a second
 * transport.
 *
 * `trade:withdraw` appears nowhere here, deliberately: it is an
 * INTERACTIVE_ONLY scope that no API key may hold, which is what protects a
 * leaked bot key from moving value off the platform.
 */

/** Unsigned decimal string. Reuses the exchange contract's rule rather than inventing a second one. */
const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');
const copySignedDecimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'amounts are signed decimal strings with at most 18 decimal places');

const copyResultAssetOutput = z
  .object({
    quoteAsset: z.string(),
    tradingFee: copySignedDecimal.nullable(),
    tradingFeeReason: z.string().nullable(),
    leaderShare: copySignedDecimal.nullable(),
    leaderShareReason: z.string().nullable(),
    leaderShareSkippedReasons: z.array(z.string()),
    mirroredOrders: z.number().int(),
    fills: z.number().int(),
    realisedPnl: copySignedDecimal.nullable(),
    realisedPnlReason: z.string().nullable(),
    unrealisedPnl: copySignedDecimal.nullable(),
    unrealisedPnlReason: z.string().nullable(),
  })
  .strict();

const copyResultOutput = z
  .object({
    followId: z.string(),
    mirroredOrders: z.number().int(),
    fills: z.number().int(),
    rejects: z.number().int(),
    tradingFee: copySignedDecimal.nullable(),
    tradingFeeReason: z.string().nullable(),
    leaderShare: copySignedDecimal.nullable(),
    leaderShareReason: z.string().nullable(),
    realisedPnl: copySignedDecimal.nullable(),
    realisedPnlReason: z.string().nullable(),
    unrealisedPnl: copySignedDecimal.nullable(),
    unrealisedPnlReason: z.string().nullable(),
    assets: z.array(copyResultAssetOutput),
  })
  .strict();

const copyTrailRowOutput = z
  .object({
    eventId: z.string(),
    followId: z.string(),
    leaderFillId: z.string(),
    kind: z.string(),
    followerOrderId: z.string().nullable(),
    followerFillId: z.string().nullable(),
    quantity: copySignedDecimal.nullable(),
    price: copySignedDecimal.nullable(),
    basisPoints: z.string().nullable(),
    code: z.string().nullable(),
    occurredAt: z.string(),
  })
  .strict();

const copyTrailOutput = z
  .object({
    rows: z.array(copyTrailRowOutput),
    nextCursor: z.string().nullable(),
  })
  .strict();

const convertSourceOutput = z.object({
  kind: z.literal('book'),
  symbol: z.string(),
  asOf: z.string(),
});

const convertQuoteOutput = z.object({
  quoteId: z.string(),
  symbol: z.string(),
  side: orderSideSchema,
  requestedQty: decimal,
  filledQty: decimal,
  bookNotional: decimal,
  userNotional: decimal,
  avgPrice: decimal,
  fullyFilled: z.boolean(),
  convertSpreadBps: z.number().int(),
  expiresAt: z.string(),
  source: convertSourceOutput,
  inAsset: z.string(),
  outAsset: z.string(),
  inAmount: decimal,
  outAmount: decimal,
});

const convertTradeOutput = z.object({
  quoteId: z.string(),
  fillId: z.string(),
  takerOrderId: z.string(),
  makerOrderId: z.string(),
  symbol: z.string(),
  side: orderSideSchema,
  inAsset: z.string(),
  outAsset: z.string(),
  inAmount: decimal,
  outAmount: decimal,
  fillPrice: decimal,
  fillNotional: decimal,
  convertSpreadBps: z.number().int(),
  source: convertSourceOutput,
  expiresAt: z.string(),
  acceptedAt: z.string(),
  settledAt: z.string(),
});

const convertAcceptInput = z.object({
  quoteId: z.string().min(1).max(64),
  clientConvertId: z.string().min(1).max(48).optional(),
  symbol: z.string().min(3).optional(),
  side: orderSideSchema.optional(),
  qty: decimal.optional(),
  maxAvgPrice: decimal.optional(),
});

const standingCaller = z.object({ userId: z.string().guid(), instructionId: z.string().guid() });

/** Only svc-bank may act for a standing instruction; the user id is the signed body's. */
function requireBankCaller(service: string | null): void {
  if (service !== 'svc-bank') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'standing-instruction convert is callable only by svc-bank' });
  }
}

/** Shared TWAP parent presentation (create/get/pause/resume/cancel). */
const algoStopReasonSchema = z
  .object({
    code: z.enum(Object.keys(ALGO_STOP_REASONS) as [AlgoStopReasonCode, ...AlgoStopReasonCode[]]),
    label: z.string(),
  })
  .nullable();

const algoParentOutputSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  side: orderSideSchema,
  kind: z.enum(['twap', 'vwap', 'pov', 'chase']),
  totalQty: decimal,
  durationMs: z.number().int(),
  sliceIntervalMs: z.number().int(),
  limitPrice: decimal.nullable(),
  status: z.enum(['active', 'paused', 'cancelled', 'completed', 'halted']),
  slicesPlanned: z.number().int(),
  nextSliceIndex: z.number().int(),
  childrenEmitted: z.number().int(),
  missesRecorded: z.number().int(),
  haltReason: z.string().nullable(),
  stopReason: algoStopReasonSchema,
  participationBps: z.number().int().nullable(),
  /** POV: what participation is applied to; null for TWAP and VWAP. */
  povBasis: z.enum(POV_BASES).nullable(),
  createdAt: z.string(),
  startedAt: z.string(),
  nextDueAt: z.string(),
  /** Projected wall-clock end after last re-space (ADR 2026-08-08). */
  projectedEndsAt: z.string(),
  /** Distinguishes user pause from tick outage; null until first stretch. */
  scheduleStretchReason: z.enum(['user_pause', 'tick_outage']).nullable(),
  /** Set when the slice sizes are random, fixed by this seed. */
  randomSeed: z.number().int().nullable(),
  /** The price the schedule waits for before its first slice; null when it starts at once. */
  triggerPrice: decimal.nullable(),
  triggeredAt: z.string().nullable(),
  awaitingTrigger: z.boolean(),
  /** Chase: the caller's maximum distance from the start price, in bps; null for other kinds. */
  chaseMaxDistanceBps: z.number().int().nullable(),
  /** Chase: the best same-side price read at create, the distance's origin. */
  chaseStartPrice: decimal.nullable(),
  /** Chase: the price of the newest child; null before the first child and for other kinds. */
  chasePrice: decimal.nullable(),
  /** Chase: how many times the child was re-priced (children placed after the first). */
  chaseReprices: z.number().int().nullable(),
});

const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'signed amounts are decimal strings with at most 18 decimal places');

const algoSchedulerOutputSchema = z.object({
  running: z.boolean().nullable(),
  reason: z.enum(['jobs_disabled', 'heartbeat_unknown', 'heartbeat_stale', 'jobs_interval_unset']).nullable(),
});

const algoScheduleHonestySchema = {
  nextSliceAt: z.string().nullable(),
  scheduler: algoSchedulerOutputSchema,
};

const algoGetOutputSchema = algoParentOutputSchema.extend({
  children: z.array(
    z.object({
      orderId: z.string(),
      sliceIndex: z.number().int(),
      time: z.string(),
      qty: decimal,
      basisQty: decimal.nullable(),
      price: decimal.nullable(),
    }),
  ),
  misses: z.array(z.object({ sliceIndex: z.number().int(), time: z.string(), code: z.string() })),
  filledQty: decimal,
  /** The planned size of every slice, in order, as stored with the parent. */
  plannedSliceQtys: z.array(decimal),
  ...algoScheduleHonestySchema,
});

const algoResultOutputSchema = z.object({
  quotes: z.array(
    z.object({
      quoteAsset: z.string(),
      filledQty: decimal,
      notional: decimal,
      averageFillPrice: decimal.nullable(),
      feesPaid: z.array(z.object({ asset: z.string(), amount: decimal })).nullable(),
      feesReason: z.enum(['fee_not_recorded']).nullable(),
      arrivalPrice: decimal.nullable(),
      arrivalReason: z.enum(['arrival_not_recorded']).nullable(),
      shortfall: signedDecimal.nullable(),
      shortfallMissing: z
        .object({
          code: z.literal('missing_input'),
          fields: z.array(z.enum(['averageFillPrice', 'arrivalPrice'])),
        })
        .nullable(),
    }),
  ),
});

const marketOutput = z.object({
  id: z.string().guid(),
  symbol: z.string(),
  base: z.string(),
  quote: z.string(),
  kind: z.enum(['spot', 'futures', 'options']),
  status: z.enum(['pending', 'active', 'halted', 'delisted']),
  tickSize: decimal,
  lotSize: decimal,
  minQty: decimal,
  maxQty: decimal.nullable(),
  minNotional: decimal,
  makerBps: z.number().int(),
  takerBps: z.number().int(),
  listedAt: z.string().nullable(),
  futuresContractStyle: z.enum(['perpetual', 'dated']).nullable(),
  futuresExpiryAt: z.string().nullable(),
  /** Stored contract family; null where none is recorded. */
  family: z.enum(['linear', 'inverse']).nullable(),
  /** Asset a futures market settles in, as stored; null where none is recorded. */
  settleAsset: z.string().nullable(),
  /** Contract multiplier as stored; null where the market never recorded one. */
  contractSize: decimal.nullable(),
  /** A futures market still in prelaunch. */
  premarket: z.boolean(),
});

const orderOutput = z.object({
  id: z.string().guid(),
  clientOrderId: z.string().nullable(),
  marketId: z.string().guid(),
  side: orderSideSchema,
  type: z.enum(['market', 'limit']),
  price: decimal.nullable(),
  qty: decimal,
  filled: decimal,
  remaining: decimal,
  status: z.enum(['pending', 'open', 'filled', 'cancelled', 'rejected', 'expired', 'recovery_required', 'hold_unknown']),
  timeInForce: timeInForceSchema,
  /** What is locked in the ledger for this order — the asset and the amount posted. */
  holdAsset: z.string(),
  holdAmount: decimal,
  feeDiscountBps: z.number().int(),
  rejectCode: z.string().nullable(),
  recoveryReason: z.enum(['SUBMIT_UNKNOWN', 'CANCEL_UNKNOWN', 'AMEND_UNKNOWN', 'RECONCILIATION_REQUIRED']).nullable(),
  reconciliationKey: z.string().nullable(),
  timestamp: z.number().int(),
});

const placeAttemptOutput = z.object({
  userId: z.string().min(1),
  tier: z.enum(['none', 'basic', 'full', 'institutional']),
  clientOrderId: z.string().min(1).max(64),
  outcome: z.enum(['refused', 'unknown', 'accepted']),
  reason: z.string().nullable(),
  orderId: z.string().guid().nullable(),
});

const fillOutput = z.object({
  id: z.string().guid(),
  orderId: z.string().guid(),
  marketId: z.string().guid(),
  side: orderSideSchema,
  takerOrMaker: z.enum(['maker', 'taker']),
  price: decimal,
  amount: decimal,
  cost: decimal,
  fee: z.object({ cost: decimal, currency: z.string(), rateBps: z.number().int() }),
  timestamp: z.number().int(),
});

function presentMarket(market: Market) {
  const futuresStyle: 'perpetual' | 'dated' | null =
    market.kind === 'futures' ? (market.futuresContractStyle === 'dated' ? 'dated' : 'perpetual') : null;
  return {
    id: market.id,
    symbol: market.symbol,
    base: market.baseAsset,
    quote: market.quoteAsset,
    kind: market.kind,
    status: market.status,
    tickSize: formatAmount(market.tickSize),
    lotSize: formatAmount(market.lotSize),
    minQty: formatAmount(market.minQty),
    maxQty: market.maxQty === null ? null : formatAmount(market.maxQty),
    minNotional: formatAmount(market.minNotional),
    makerBps: market.makerBps,
    takerBps: market.takerBps,
    listedAt: market.listedAt?.toISOString() ?? null,
    futuresContractStyle: futuresStyle,
    futuresExpiryAt: market.futuresExpiryAt?.toISOString() ?? null,
    family: market.kind === 'futures' ? (market.futuresFamily ?? null) : null,
    settleAsset: market.kind === 'futures' ? (market.futuresSettleAsset ?? null) : null,
    contractSize: market.kind === 'futures' && market.contractSize != null ? formatAmount(market.contractSize) : null,
    premarket: isPremarket(market),
  };
}

function presentOrder(order: OrderRecord) {
  return {
    id: order.id,
    clientOrderId: order.clientOrderId,
    marketId: order.marketId,
    side: order.side,
    type: order.type,
    price: order.price === null ? null : formatAmount(order.price),
    qty: formatAmount(order.qty),
    filled: formatAmount(order.filledQty),
    remaining: formatAmount(order.qty - order.filledQty),
    status: order.status,
    timeInForce: order.tif,
    holdAsset: order.holdAsset,
    holdAmount: formatAmount(order.holdAmount),
    feeDiscountBps: order.feeDiscountBps,
    rejectCode: order.rejectCode,
    recoveryReason: order.recoveryReason,
    reconciliationKey: order.reconciliationKey,
    timestamp: order.createdAt.getTime(),
  };
}

function presentFill(fill: FillRecord) {
  return {
    id: fill.id,
    orderId: fill.orderId,
    marketId: fill.marketId,
    side: fill.side,
    takerOrMaker: fill.liquidity,
    price: formatAmount(fill.price),
    amount: formatAmount(fill.qty),
    cost: formatAmount(fill.quoteAmount),
    fee: { cost: formatAmount(fill.feeAmount), currency: fill.feeAsset, rateBps: fill.feeBps },
    timestamp: fill.ts.getTime(),
  };
}

/**
 * Map a domain error to the wire.
 *
 * Integrators branch on these, so the mapping is part of the contract: a venue
 * that returns the wrong class breaks every bot's retry logic. In particular
 * `ledger.insufficient_funds` must NOT look retryable — retrying a rejected
 * hold just rejects it again — while an unreachable engine must, because the
 * order may not have been placed at all.
 */
export function toTrpcError(err: unknown): TRPCError {
  const historyError = convertHistoryTrpcError(err);
  if (historyError) return historyError;
  const desk = deskTrpcError(err);
  if (desk) return desk;
  const copyClose = copyCloseTrpcError(err);
  if (copyClose) return copyClose;
  // Identity's step-up codes (a copy close-all) reach the person unchanged: confirm again (403), or identity could not
  // check it (503).
  if (err instanceof StepUpCheckError) {
    const code = err.code === 'identity.step_up_required' ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE';
    return new TRPCError({ code, message: err.message, cause: err });
  }
  if (err instanceof TradingControlError) {
    let code: 'SERVICE_UNAVAILABLE' | 'CONFLICT' | 'FORBIDDEN' = 'FORBIDDEN';
    if (err.code === 'authority.unavailable') code = 'SERVICE_UNAVAILABLE';
    else if (err.code === 'operation.conflict') code = 'CONFLICT';
    return new TRPCError({
      code,
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof InsufficientFundsError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }

  if (
    err instanceof FillsMineLimitUnsetError ||
    err instanceof OrderHistoryLimitUnsetError ||
    err instanceof OpenOrdersLimitUnsetError ||
    err instanceof MarketsLimitUnsetError ||
    err instanceof ListMyFollowsLimitUnsetError
  ) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof OtcError) {
    switch (err.code) {
      case 'trade.otc_quote_missing':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'trade.otc_not_owner':
      case 'trade.otc_stake_gate':
      case 'trade.otc_level_insufficient':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      case 'trade.otc_desk_law_blank':
      case 'trade.otc_settle_refused':
      case 'trade.otc_stake_unavailable':
      case 'trade.otc_no_reference_price':
      case 'trade.otc_bad_spread':
      case 'trade.convert_bounds_not_set':
      case 'trade.rfq_allocation_refused':
      case 'trade.rfq_give_up_refused':
      case 'trade.rfq_missing_price':
      case 'trade.otc_makers_unset':
      case 'trade.otc_assets_unset':
      case 'trade.otc_level_unset':
      case 'trade.rfq_size_not_set':
      case 'feed.market':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof CopyError) {
    switch (err.code) {
      case 'trade.copy_not_following':
      case 'trade.copy_leader_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'trade.copy_jurisdiction_blocked':
      case 'trade.copy_self_follow':
      case 'trade.copy_fee_share_killed':
      case 'trade.copy_pnl_fee_forbidden':
      case 'trade.copy_ranking_forbidden':
      case 'trade.copy_leader_resume_forbidden':
      case 'trade.tier_insufficient':
      case 'trade.copy_subaccount_refused':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      case 'trade.copy_fee_share_blank':
      case 'trade.copy_jurisdiction_blank':
      case 'trade.copy_law_blank':
      case 'trade.copy_settle_refused':
      case 'trade.copy_leader_fill_not_found':
      case 'trade.copy_auto_mirror_place_socket':
      case 'trade.copy_place_disabled':
      case 'trade.copy_unavailable':
      case 'trade.copy_session_key_missing':
      case 'trade.copy_session_key_revoked':
      case 'trade.copy_paused':
      case 'trade.copy_stopped':
      case 'trade.copy_detached':
      case 'trade.copy_flatten_refused':
      case 'trade.copy_flatten_drift':
      case 'trade.copy_flatten_unavailable':
      case 'trade.copy_flatten_partial':
      case 'trade.copy_leader_suspended':
      case 'trade.copy_leader_delisted':
      case 'trade.copy_leader_capacity_full':
      case 'trade.copy_tier_unset':
      case 'trade.copy_reserve_exceeds_balance':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'trade.copy_paper_live_forbidden':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof TradeError) {
    switch (err.code) {
      case 'trade.market_not_found':
      case 'trade.order_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'trade.not_owner':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      case 'trade.spot_disabled':
      case 'trade.market_not_tradable':
      case 'trade.market_kind_unsupported':
      // `TRADE_FUTURES_ENABLED` off. FORBIDDEN, next to the other refusals that
      // are decisions rather than faults — explicitly not
      // INTERNAL_SERVER_ERROR, because the shipped default of a flag is not a
      // server error and must never page anybody.
      case 'trade.futures_disabled':
      case 'trade.fx_not_spot':
      case 'trade.paper_fill_refused':
      // RC-identity-01: the person proves their email, then retries.
      case 'trade.email_proof_required':
      // Below the bot verification level, or no level published: 403, as on the REST door (ccxt-errors.ts).
      case 'trade.bots_verification_insufficient':
      case 'trade.bots_verification_level_not_set':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      // Identity could not answer the email-proof read; nothing moved, try again.
      case 'trade.identity_unavailable':
        return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: err.message, cause: err });
      case 'trade.perks_unavailable':
        return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err });
      case 'trade.dust_fill':
      case 'trade.fee_exceeds_fill':
      case 'trade.hold_uncovered':
      case 'trade.reconcile_unknown_engine_miss':
        // Neither is the caller's fault and neither is retryable by them. They
        // are operator alarms that happen to surface on a request.
        return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof JurisdictionError) {
    return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
  }

  if (err instanceof AuthError) {
    return new TRPCError({ code: err.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN', message: err.message, cause: err });
  }

  if (err instanceof LedgerError) {
    // The cause's code is what a client reads (`data.cause.code`). The posting freeze travels as the API names it:
    // `posting_frozen` (refused before the engine, a 400 like the REST door) or `trade.settlement_pending` (after the
    // engine: the outcome is not known, so not a refusal). The ledger's own error stays the cause of the renamed one.
    const published = publicLedgerCode(err);
    if (published === err.code) return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    const message = publicLedgerMessage(err);
    const cause = new LedgerError(message, published);
    cause.cause = err;
    if (err.stack) cause.stack = err.stack;
    return new TRPCError({ code: published === SETTLEMENT_PENDING ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST', message, cause });
  }

  // Matching holds no book for the market (its 404): the named refusal `trade.no_book`, as on the REST and ccxt
  // doors, not a 500. Mapped here, at the door, so the service's own TradeError catch-alls (copy mirroring retries a
  // missing book on the next tick) keep treating it as the transient engine state it is.
  if (err instanceof MatchingNoBookError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }

  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: err });
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

type PlaceAttemptOutcome = 'refused' | 'unknown' | 'accepted';

interface StoredPlaceAttempt {
  readonly userId: string;
  readonly tier: Principal['tier'];
  readonly clientOrderId: string;
  outcome: PlaceAttemptOutcome;
  reason: string | null;
  orderId: string | null;
}

/**
 * Latest custodial place for a user and clientOrderId. An officer reads this
 * record. It does not decide the customer's answer. A new key past `maxRows`
 * drops the oldest row. Writing the same key again replaces the row and does
 * not add a second clientOrderId entry.
 */
export class PlaceAttemptBook {
  private readonly byKey = new Map<string, StoredPlaceAttempt>();
  private readonly byClientOrderId = new Map<string, string[]>();

  constructor(private readonly maxRows = 10_000) {}

  private key(userId: string, clientOrderId: string): string {
    return `${userId}\0${clientOrderId}`;
  }

  /** Latest write wins. A repeat for the same user and clientOrderId replaces the row. */
  record(row: StoredPlaceAttempt): void {
    const key = this.key(row.userId, row.clientOrderId);
    if (!this.byKey.has(key)) {
      if (this.byKey.size >= this.maxRows) this.evictOldest();
      const keys = this.byClientOrderId.get(row.clientOrderId) ?? [];
      keys.push(key);
      this.byClientOrderId.set(row.clientOrderId, keys);
    }
    this.byKey.set(key, row);
  }

  private evictOldest(): void {
    const oldest = this.byKey.keys().next();
    if (oldest.done) return;
    const key = oldest.value;
    const row = this.byKey.get(key);
    this.byKey.delete(key);
    if (!row) return;
    const keys = this.byClientOrderId.get(row.clientOrderId);
    if (!keys) return;
    const remaining = keys.filter((item) => item !== key);
    if (remaining.length === 0) this.byClientOrderId.delete(row.clientOrderId);
    else this.byClientOrderId.set(row.clientOrderId, remaining);
  }

  lookup(clientOrderId: string): StoredPlaceAttempt {
    const keys = this.byClientOrderId.get(clientOrderId) ?? [];
    if (keys.length === 0) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'place attempt not found' });
    }
    if (keys.length > 1) {
      throw new TRPCError({ code: 'CONFLICT', message: 'clientOrderId matches more than one account' });
    }
    const row = this.byKey.get(keys[0]!);
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'place attempt not found' });
    return row;
  }
}

function presentPlaceAttempt(row: StoredPlaceAttempt) {
  return {
    userId: row.userId,
    tier: row.tier,
    clientOrderId: row.clientOrderId,
    outcome: row.outcome,
    reason: row.reason,
    orderId: row.orderId,
  };
}

function isPlaceTimeout(err: unknown): boolean {
  if (err instanceof TradeError && err.code === 'trade.hold_unknown') return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const code = 'code' in err && typeof err.code === 'string' ? err.code : '';
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || code === 'ABORT_ERR') return true;
  return /\btimeout\b/i.test(err.message);
}

function refusalReason(err: unknown): string {
  if (err instanceof TradeError || err instanceof AuthError || err instanceof JurisdictionError) return err.code;
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code;
  return 'refused';
}

interface CustodialPlaceInput {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'market' | 'limit';
  readonly qty: string;
  readonly price?: string;
  readonly timeInForce?: TimeInForce;
  readonly clientOrderId: string;
  readonly subAccountId?: string;
}

function refuseCustodialTradeJurisdiction(ctx: Context & { principal: Principal }): void {
  const decision = checkAccess({
    module: 'trade',
    plane: 'fiat',
    region: ctx.region,
    kycTier: ctx.principal.tier,
  });
  if (!decision.allowed) throw new JurisdictionError(decision);
}

/**
 * Record the place, then hold. Tier below `basic` is `tier.insufficient` and
 * never calls `placeOrder`. A jurisdiction refusal is recorded and thrown the
 * same way. Every other call reaches `placeOrder`. The book stores the latest
 * outcome and does not answer the retry. A timeout stays `unknown` and returns
 * no order.
 */
async function placeAttributedOrder(
  ctx: Context & { principal: Principal },
  input: CustodialPlaceInput,
  trade: TradeService,
  book: PlaceAttemptBook,
) {
  const principal = ctx.principal;
  const base = {
    userId: principal.userId,
    tier: principal.tier,
    clientOrderId: input.clientOrderId,
    orderId: null as string | null,
  };

  if (TIER_ORDER[principal.tier] < TIER_ORDER.basic) {
    book.record({
      ...base,
      outcome: 'refused',
      reason: 'tier.insufficient',
    });
    requireTier(principal, 'basic');
    throw new AuthError('Verification tier "basic" is required', 'tier.insufficient');
  }

  try {
    refuseCustodialTradeJurisdiction(ctx);
  } catch (err) {
    book.record({
      ...base,
      outcome: 'refused',
      reason: refusalReason(err),
    });
    throw err;
  }

  book.record({
    ...base,
    outcome: 'unknown',
    reason: null,
  });

  try {
    const order = await trade.placeOrder(principal, {
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      qty: parseAmount(input.qty),
      price: input.price === undefined ? null : parseAmount(input.price),
      tif: input.timeInForce,
      clientOrderId: input.clientOrderId,
      subAccountId: input.subAccountId,
    });
    book.record({
      ...base,
      outcome: 'accepted',
      reason: null,
      orderId: order.id,
    });
    return presentOrder(order);
  } catch (err) {
    if (isPlaceTimeout(err)) {
      book.record({
        ...base,
        outcome: 'unknown',
        reason: null,
        orderId: null,
      });
      throw new TradeError('place outcome is unknown', 'trade.hold_unknown');
    }
    book.record({
      ...base,
      outcome: 'refused',
      reason: refusalReason(err),
      orderId: null,
    });
    throw err;
  }
}

export function createTradeRouter(
  trade: TradeService,
  otc?: OtcDeskService,
  copy?: CopyService,
  controls?: TradingControls,
  admin?: TradeOpsAdmin,
  insuranceTopups?: InsuranceTopupAdmin,
  supportSummary?: SupportTradeSummaryReader,
  leadDesk?: LeadDesk,
  grid?: GridService,
) {
  const placeAttempts = new PlaceAttemptBook();
  /** The lead desk's refusals carry their code at the end of the message, where the console reads it. */
  // Mapped outside `guard`: guard wraps any TRPCError thrown inside it again as a 500, which loses the code.
  const lead = async <T>(fn: (desk: LeadDesk) => Promise<T>): Promise<T> => {
    try {
      if (!leadDesk) throw new CopyError('Copy trading is not available', 'trade.copy_unavailable');
      return await fn(leadDesk);
    } catch (err) {
      if (err instanceof CopyError && err.code.startsWith('trade.copy_lead_')) {
        const code =
          err.code === 'trade.copy_lead_application_not_found'
            ? 'NOT_FOUND'
            : err.code === 'trade.copy_lead_criteria_unset'
              ? 'PRECONDITION_FAILED'
              : 'BAD_REQUEST';
        throw new TRPCError({ code, message: `${err.message} [${err.code}]`, cause: err });
      }
      if (err instanceof TradeOpsError)
        throw new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [trade_ops.${err.code}]`, cause: err });
      throw toTrpcError(err);
    }
  };
  return router({
    accountControls: tradingControlsRouter(controls),
    admin: mergeRouters(tradeOpsAdminRouter(admin), insuranceAdminRouter(insuranceTopups)),
    /** `support.tradeSummary`: read-only, svc-support only (D-ops-06). The case check is svc-support's; this door audits the read. */
    support: supportTradeSummaryRouter(supportSummary),
    /** `bots.grid.*`: the spot grid bot (grid/router.ts). Unmounted, every door answers `trade.grid_unavailable`. */
    bots: router({ grid: gridRouter(grid) }),
    health: publicProcedure
      .output(z.object({ ok: z.boolean(), service: z.literal('svc-trade') }))
      .query(() => ({ ok: true, service: 'svc-trade' as const })),

    markets: router({
      /** Public. Reading what is listed needs no authentication (§9). */
      list: publicProcedure
        .input(z.object({ limit: z.number().int().min(1).max(500) }))
        .output(z.array(marketOutput))
        .query(async ({ input }) => (await trade.markets(input.limit)).map(presentMarket)),

      get: publicProcedure
        .input(z.object({ symbol: z.string().min(3) }))
        .output(marketOutput)
        .query(async ({ input }) => {
          const market = await trade.marketBySymbol(input.symbol);
          if (!market) throw new TRPCError({ code: 'NOT_FOUND', message: `market ${input.symbol} not found` });
          return presentMarket(market);
        }),
    }),

    orders: router({
      /**
       * THE MONEY PATH. `trade:write`, then `placeAttributedOrder`: tier and
       * jurisdiction are recorded against clientOrderId before any hold.
       * The book is a record the officer reads. `placeOrder` decides a retry.
       * The middleware does not take `{ module: 'trade' }` — that gate throws
       * before the attempt row exists, so a tier refusal would be invisible.
       */
      create: scopedProcedure('trade:write')
        .input(
          z
            .object({
              symbol: z.string().min(3),
              side: orderSideSchema,
              type: z.enum(['market', 'limit']),
              qty: decimal,
              price: decimal.optional(),
              timeInForce: timeInForceSchema.optional(),
              /**
               * Required. Without one a retry opens a second hold under a fresh
               * order id — the money-path equivalent of double-spend on a timeout.
               */
              clientOrderId: z.string().min(1).max(64),
              subAccountId: z.string().guid().optional(),
            })
            .superRefine((order, ctx) => {
              // Rejected at the boundary rather than guessed at: a limit order
              // with no price is the single most common integration bug, and a
              // market order carrying one is a caller who thinks they placed a
              // limit.
              if (order.type === 'limit' && order.price === undefined) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['price'], message: 'a limit order requires a price' });
              }
              if (order.type === 'market' && order.price !== undefined) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['price'], message: 'a market order must not carry a price' });
              }
            }),
        )
        .output(orderOutput)
        .mutation(({ ctx, input }) => guard(() => placeAttributedOrder(ctx, input, trade, placeAttempts))),

      /** Risk officer read of the latest place attempt for a clientOrderId. No hold. */
      placeAttempt: scopedProcedure('admin:read')
        .input(z.object({ clientOrderId: z.string().min(1).max(64) }).strict())
        .output(placeAttemptOutput)
        .query(({ input }) => presentPlaceAttempt(placeAttempts.lookup(input.clientOrderId))),

      /**
       * Cancelling is `trade:write` but is NOT gated on the market being
       * tradable or on the kill-switch. An operator who has halted a market
       * must still let users out; a control that traps funds is not a safety
       * control.
       */
      cancel: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ orderId: z.string().guid() }))
        .output(orderOutput)
        .mutation(({ ctx, input }) => guard(async () => presentOrder(await trade.cancelOrder(ctx.principal, input.orderId)))),

      cancelAll: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ marketId: z.string().guid().optional() }).optional())
        .output(z.array(orderOutput))
        .mutation(({ ctx, input }) => guard(async () => (await trade.cancelAllOrders(ctx.principal, input?.marketId)).map(presentOrder))),

      massCancel: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ marketId: z.string().guid() }))
        .output(z.array(orderOutput))
        .mutation(({ ctx, input }) => guard(async () => (await trade.massCancelOrders(ctx.principal, input.marketId)).map(presentOrder))),

      get: scopedProcedure('trade:read')
        .input(z.object({ orderId: z.string().guid() }))
        .output(orderOutput)
        .query(({ ctx, input }) => guard(async () => presentOrder(await trade.getOrder(ctx.principal, input.orderId)))),

      open: scopedProcedure('trade:read')
        .input(
          z
            .object({
              marketId: z.string().guid().optional(),
              limit: z.number().int().min(1).max(500).optional(),
            })
            .optional(),
        )
        .output(z.array(orderOutput))
        .query(({ ctx, input }) =>
          guard(async () =>
            (await trade.openOrders(ctx.principal, input?.marketId, publishedOpenOrdersLimit(input?.limit))).map(presentOrder),
          ),
        ),

      history: scopedProcedure('trade:read')
        .input(
          z.object({
            marketId: z.string().guid().optional(),
            limit: z.number().int().min(1).max(500),
          }),
        )
        .output(z.array(orderOutput))
        .query(({ ctx, input }) =>
          guard(async () => (await trade.orderHistory(ctx.principal, { marketId: input.marketId, limit: input.limit })).map(presentOrder)),
        ),
    }),

    fills: router({
      mine: scopedProcedure('trade:read')
        .input(z.object({ limit: z.number().int().min(1).max(500) }))
        .output(z.array(fillOutput))
        .query(({ ctx, input }) => guard(async () => (await trade.myFills(ctx.principal, input.limit)).map(presentFill))),

      forOrder: scopedProcedure('trade:read')
        .input(
          z.object({
            orderId: z.string().guid(),
            limit: z.number().int().min(1).max(500).optional(),
          }),
        )
        .output(z.array(fillOutput))
        .query(({ ctx, input }) =>
          guard(async () =>
            (await trade.fillsForOrder(ctx.principal, input.orderId, publishedFillsMineLimit(input.limit))).map(presentFill),
          ),
        ),
    }),

    /**
     * Convert for a svc-bank auto-invest schedule. No principal: the signed
     * service call names the user and the instruction. Identity decides the
     * `standing_instruction` authority; this door only proves the caller.
     */
    standing: router({
      quote: serviceProcedure
        .input(
          standingCaller.extend({
            symbol: z.string().min(3),
            side: orderSideSchema,
            qty: decimal.optional(),
            quoteQty: decimal.optional(),
          }),
        )
        .output(convertQuoteOutput)
        .mutation(({ ctx, input }) => {
          requireBankCaller(ctx.service);
          return guard(async () => {
            return trade.standingConvertQuote(input.userId, input.instructionId, {
              symbol: input.symbol,
              side: input.side,
              qty: input.qty === undefined ? undefined : parseAmount(input.qty),
              quoteQty: input.quoteQty === undefined ? undefined : parseAmount(input.quoteQty),
            });
          });
        }),

      execute: serviceProcedure
        .input(standingCaller.extend(convertAcceptInput.shape))
        .output(convertTradeOutput)
        .mutation(({ ctx, input }) => {
          requireBankCaller(ctx.service);
          return guard(async () => {
            return trade.standingConvertExecute(input.userId, input.instructionId, {
              quoteId: input.quoteId,
              clientConvertId: input.clientConvertId,
              symbol: input.symbol,
              side: input.side,
              qty: input.qty === undefined ? undefined : parseAmount(input.qty),
              maxAvgPrice: input.maxAvgPrice === undefined ? null : parseAmount(input.maxAvgPrice),
            });
          });
        }),
    }),

    /**
     * One-tap Convert (`trade.convert`) — firm RFQ. Book is the quote source;
     * accept settles exact in/out via ledger-client (not a matching order).
     */
    convert: router({
      quote: scopedProcedure('trade:read', { module: 'trade' })
        .input(
          z.object({
            symbol: z.string().min(3),
            side: orderSideSchema,
            /** Base amount. Exactly one of `qty` or `quoteQty`; the service refuses both or neither. */
            qty: decimal.optional(),
            /** Spend in the quote asset ("spend 100 USDT"), buy only; never charges more than this. */
            quoteQty: decimal.optional(),
          }),
        )
        .output(convertQuoteOutput)
        .query(({ ctx, input }) =>
          guard(async () =>
            trade.convertQuote(ctx.principal, {
              symbol: input.symbol,
              side: input.side,
              qty: input.qty === undefined ? undefined : parseAmount(input.qty),
              quoteQty: input.quoteQty === undefined ? undefined : parseAmount(input.quoteQty),
            }),
          ),
        ),

      accept: scopedProcedure('trade:write', { module: 'trade' })
        .input(convertAcceptInput)
        .output(convertTradeOutput)
        .mutation(({ ctx, input }) =>
          guard(async () =>
            trade.convertAccept(ctx.principal, {
              quoteId: input.quoteId,
              clientConvertId: input.clientConvertId,
              symbol: input.symbol,
              side: input.side,
              qty: input.qty === undefined ? undefined : parseAmount(input.qty),
              maxAvgPrice: input.maxAvgPrice === undefined ? null : parseAmount(input.maxAvgPrice),
            }),
          ),
        ),

      execute: scopedProcedure('trade:write', { module: 'trade' })
        .input(convertAcceptInput)
        .output(convertTradeOutput)
        .mutation(({ ctx, input }) =>
          guard(async () =>
            trade.convertExecute(ctx.principal, {
              quoteId: input.quoteId,
              clientConvertId: input.clientConvertId,
              symbol: input.symbol,
              side: input.side,
              qty: input.qty === undefined ? undefined : parseAmount(input.qty),
              maxAvgPrice: input.maxAvgPrice === undefined ? null : parseAmount(input.maxAvgPrice),
            }),
          ),
        ),

      ...convertHistoryProcedures(trade),
    }),

    /**
     * OTC RFQ desk (trade.otc / D-S-02 Part A).
     * Default desk law unpublished → refuse-closed (DIRECTION §8). Never invents spread/stake.
     */
    otc: router({
      policy: publicProcedure.query(() => describeOtcPolicy()),

      deskStatus: scopedProcedure('trade:read', { module: 'trade' }).query(() => {
        if (!otc) {
          const deskLaw = OTC_DESK_LAW_RESIDUAL;
          return {
            published: false,
            statusLine: otcDeskLawStatusLine(UNPUBLISHED_OTC_DESK_LAW),
            residual: deskLaw,
            assets: null,
            minTier: null,
            makerRouting: otcMakerRoutingStatus(),
            midFeed: otcMidFeedStatus(),
            residuals: {
              deskLaw,
              assets: deskLaw,
              minTier: deskLaw,
              makerRouting: OTC_MAKER_ROUTING_RESIDUAL,
              midFeed: OTC_MID_FEED_RESIDUAL,
            },
          };
        }
        return otc.deskStatus();
      }),

      /** Liquidity-provider directory and multi-select check (CB-otc-01). */
      makers: router({
        list: scopedProcedure('trade:read', { module: 'trade' }).query(() =>
          otc ? otc.listMakers() : listOtcMakers(UNPUBLISHED_OTC_MAKER_DIRECTORY),
        ),
        select: scopedProcedure('trade:read', { module: 'trade' })
          .input(z.object({ makerIds: z.array(z.string().max(120)).max(50) }).strict())
          .query(({ input }) =>
            guard(async () => {
              if (!otc) {
                return { makers: selectOtcMakers(UNPUBLISHED_OTC_MAKER_DIRECTORY, input.makerIds), selectCap: null };
              }
              return otc.selectMakers(input.makerIds);
            }),
          ),
      }),

      quote: scopedProcedure('trade:read', { module: 'trade' })
        .input(
          /**
           * `.strict()`, and it is the money guard rather than tidiness.
           *
           * zod strips unknown keys by default, so a body carrying `midPrice`
           * was accepted and silently discarded. That is the posture #1097
           * fixed the *reading* of but not the *shape* of: a client sending a
           * price got a 200 and a quote priced off something else, which is
           * indistinguishable from the desk having honoured it. On the one
           * surface where the customer naming the price was a live exploit,
           * an unknown field is refused and named instead of ignored.
           */
          z
            .object({
              side: orderSideSchema,
              baseAsset: z.string().min(1).max(32),
              quoteAsset: z.string().min(1).max(32),
              qty: decimal,
              makerId: z.string().min(1).max(120).optional(),
              /** CB-otc-01: the providers this request asks, from `otc.makers.list`; the owner's cap is checked in the desk. */
              makerIds: z.array(z.string().max(120)).max(50).optional(),
            })
            .strict(),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            // No `midPrice` on this input, deliberately. The taker names the
            // side and the size; the desk names the price.
            return otc.quote(ctx.principal, {
              side: input.side,
              baseAsset: input.baseAsset,
              quoteAsset: input.quoteAsset,
              qty: input.qty,
              makerId: input.makerId,
              makerIds: input.makerIds,
            });
          }),
        ),

      accept: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          /**
           * `assertedPrice` is the one price the customer may send, and it can
           * only ever cause a REFUSAL: it must equal the quoted price or the
           * accept is rejected as last look. It is never the price that fills.
           */
          z
            .object({
              quoteId: z.string().guid(),
              assertedPrice: decimal.optional(),
            })
            .strict(),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.accept(ctx.principal, {
              quoteId: input.quoteId,
              assertedPrice: input.assertedPrice,
            });
          }),
        ),

      settle: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ quoteId: z.string().guid() }).strict())
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.settle(ctx.principal, { quoteId: input.quoteId });
          }),
        ),

      /** Owner bounds for one-click buy and convert at OTC pricing (CB-otc-12). */
      convertBounds: scopedProcedure('trade:read', { module: 'trade' }).query(() =>
        otc ? otc.convertBoundsStatus() : { convert: null, oneClickBuy: null },
      ),

      /** Bounds-gated OTC quote for one-click buy / convert. The desk names the price. */
      convertQuote: scopedProcedure('trade:read', { module: 'trade' })
        .input(
          z
            .object({
              flow: z.enum(['convert', 'oneClickBuy']),
              side: orderSideSchema,
              baseAsset: z.string().min(1).max(32),
              quoteAsset: z.string().min(1).max(32),
              qty: decimal,
            })
            .strict(),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.convertQuote(ctx.principal, input);
          }),
        ),
    }),

    /**
     * Professional RFQ (PTX-M12) — firm quote/accept/expire on the OTC desk.
     * Size required; desk names the price (no mid on the wire). Not a book fill.
     */
    rfq: router({
      ...rfqHistoryProcedures(trade),
      quote: scopedProcedure('trade:read', { module: 'trade' })
        .input(
          z
            .object({
              side: orderSideSchema,
              baseAsset: z.string().min(1).max(32),
              quoteAsset: z.string().min(1).max(32),
              qty: z.string(),
              makerId: z.string().min(1).max(120).optional(),
              /** CB-otc-01: the providers this request asks, from `otc.makers.list`; the owner's cap is checked in the desk. */
              makerIds: z.array(z.string().max(120)).max(50).optional(),
            })
            .strict(),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.rfqQuote(ctx.principal, {
              side: input.side,
              baseAsset: input.baseAsset,
              quoteAsset: input.quoteAsset,
              qty: input.qty,
              makerId: input.makerId,
              makerIds: input.makerIds,
            });
          }),
        ),

      accept: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ quoteId: z.string().guid(), assertedPrice: decimal.optional() }).strict())
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.rfqAccept(ctx.principal, {
              quoteId: input.quoteId,
              assertedPrice: input.assertedPrice,
            });
          }),
        ),

      expire: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ quoteId: z.string().guid() }).strict())
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.rfqExpire(ctx.principal, { quoteId: input.quoteId });
          }),
        ),

      get: scopedProcedure('trade:read', { module: 'trade' })
        .input(z.object({ quoteId: z.string().guid() }).strict())
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.rfqGet(ctx.principal, input.quoteId);
          }),
        ),

      allocate: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ quoteId: z.string().guid(), allocations: z.array(z.unknown()).min(1) }).strict())
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.rfqAllocate(ctx.principal, { quoteId: input.quoteId });
          }),
        ),

      giveUp: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z
            .object({
              quoteId: z.string().guid(),
              carryingAccount: z.string().min(1).max(120).optional(),
            })
            .strict(),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.rfqGiveUp(ctx.principal, { quoteId: input.quoteId });
          }),
        ),
    }),

    /**
     * TWAP algo (D-S-04 / trade.algo) — schedule emits child orders.
     * Parent holds no value; progress is sum of child fills only.
     */
    algo: router({
      // The flags this service was started with, so the room shows whether slices are placed (CB-order-controls-03 #1).
      policy: publicProcedure.query(() => trade.algoPolicy()),
      ...algoDeskProcedures(trade),

      createTwap: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            symbol: z.string().min(3),
            side: orderSideSchema,
            totalQty: decimal,
            durationMs: z.number().int().min(1_000).max(86_400_000),
            sliceIntervalMs: z.number().int().min(1_000).max(86_400_000),
            limitPrice: decimal.optional(),
            clientAlgoId: z.string().trim().min(1).max(48),
            subAccountId: z.string().guid().optional(),
            kind: z.enum(['twap', 'vwap', 'pov', 'chase']).optional(),
            participationBps: z.number().int().min(1).max(10_000).optional(),
            chaseDistanceBps: z.number().int().min(1).max(10_000).optional(),
            povBasis: z.enum(POV_BASES).optional(),
            randomSeed: z.number().int().min(0).max(MAX_ALGO_SEED).optional(),
            triggerPrice: decimal.optional(),
          }),
        )
        .output(algoParentOutputSchema)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const parent = await trade.createTwap(ctx.principal, {
              symbol: input.symbol,
              side: input.side,
              totalQty: parseAmount(input.totalQty),
              durationMs: input.durationMs,
              sliceIntervalMs: input.sliceIntervalMs,
              limitPrice: input.limitPrice === undefined ? null : parseAmount(input.limitPrice),
              clientAlgoId: input.clientAlgoId,
              subAccountId: input.subAccountId,
              kind: input.kind ?? 'twap',
              participationBps: input.participationBps,
              povBasis: input.povBasis,
              randomSeed: input.randomSeed,
              triggerPrice: input.triggerPrice === undefined ? undefined : parseAmount(input.triggerPrice),
              chaseDistanceBps: input.chaseDistanceBps,
            });
            return presentAlgo(parent);
          }),
        ),

      get: scopedProcedure('trade:read')
        .input(z.object({ algoId: z.string().min(1) }))
        .output(algoGetOutputSchema)
        .query(({ ctx, input }) =>
          guard(async () => {
            const parent = await trade.getAlgo(ctx.principal, input.algoId);
            const progress = await trade.algoProgress(ctx.principal, input.algoId);
            const plan = await trade.algoPlan(ctx.principal, input.algoId);
            return {
              ...presentAlgo(parent),
              plannedSliceQtys: plan.map(formatAmount),
              ...presentAlgoDesk(parent, progress.filledQty),
              ...presentScheduleHonesty(parent, progress.scheduler),
            };
          }),
        ),

      // The slice sizes a TWAP create would plan, so the review shows exactly what the service will place.
      previewTwapSizes: scopedProcedure('trade:read')
        .input(
          z.object({
            symbol: z.string().min(3),
            totalQty: decimal,
            durationMs: z.number().int().min(1_000).max(86_400_000),
            sliceIntervalMs: z.number().int().min(1_000).max(86_400_000),
            randomSeed: z.number().int().min(0).max(MAX_ALGO_SEED).optional(),
          }),
        )
        .output(z.object({ sliceQtys: z.array(decimal) }))
        .query(({ ctx, input }) =>
          guard(async () => {
            const slices = await trade.previewTwapSizes(ctx.principal, {
              symbol: input.symbol,
              totalQty: parseAmount(input.totalQty),
              durationMs: input.durationMs,
              sliceIntervalMs: input.sliceIntervalMs,
              randomSeed: input.randomSeed,
            });
            return { sliceQtys: slices.map(formatAmount) };
          }),
        ),

      result: scopedProcedure('trade:read')
        .input(z.object({ algoId: z.string().min(1) }))
        .output(algoResultOutputSchema)
        .query(({ ctx, input }) => guard(async () => trade.algoResult(ctx.principal, input.algoId))),

      progress: scopedProcedure('trade:read')
        .input(z.object({ algoId: z.string().min(1) }))
        .output(
          z.object({
            parentId: z.string(),
            status: z.enum(['active', 'paused', 'cancelled', 'completed', 'halted']),
            haltReason: z.string().nullable(),
            stopReason: algoStopReasonSchema,
            childrenEmitted: z.number().int(),
            missesRecorded: z.number().int(),
            slicesPlanned: z.number().int(),
            nextSliceIndex: z.number().int(),
            filledQty: decimal,
            totalQty: decimal,
            ...algoScheduleHonestySchema,
          }),
        )
        .query(({ ctx, input }) => guard(async () => trade.algoProgress(ctx.principal, input.algoId))),

      pause: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ algoId: z.string().min(1) }))
        .mutation(({ ctx, input }) => guard(async () => presentAlgo(await trade.pauseAlgo(ctx.principal, input.algoId)))),

      resume: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ algoId: z.string().min(1) }))
        .mutation(({ ctx, input }) => guard(async () => presentAlgo(await trade.resumeAlgo(ctx.principal, input.algoId)))),

      cancel: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ algoId: z.string().min(1) }))
        .mutation(({ ctx, input }) => guard(async () => presentAlgo(await trade.cancelAlgo(ctx.principal, input.algoId)))),
    }),

    /**
     * Forex settlement posture (trade.forex / D26-P1-T7).
     * Always refuse-closed until D26-P0-05 + fiat settle rails — never invents
     * settlement asset. §13 socket.forex-settlement.
     *
     * Completeness = honest refuse product on public doors (status + listing
     * probe + place path), not fundable FX. Do not mark trade.forex done.
     */
    forex: router({
      settlementStatus: scopedProcedure('trade:read', { module: 'trade' }).query(() => forexSettlementStatus()),

      /**
       * R-fx product posture. FX is not crypto spot convert/matching.
       * Holiday calendar + rail named degrade — never invent mids or days.
       */
      productStatus: scopedProcedure('trade:read', { module: 'trade' }).query(() => fxNamedDegrade()),

      /**
       * Same listing gate as TradeService.listMarket / setMarketStatus(active).
       * Public-door probe so refuse is not unit-helper-only until an admin
       * listMarket transport mounts. Production active non-paper forex/
       * commodity → trade.unsettled_asset_class_listing naming the socket.
       */
      assertProductionListing: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            assetClass: z.enum(['crypto', 'commodity', 'forex']),
            status: z.enum(['active', 'pending', 'halted', 'delisted']),
            paper: z.boolean(),
          }),
        )
        .mutation(({ input }) =>
          guard(async () => {
            assertProductionUnsettledAssetClassListing(input);
            return { ok: true as const, refused: false as const };
          }),
        ),
    }),

    /**
     * Futures product policy (trade.futures / D26-P1-T1g).
     * Jobs capability + insurance listing + ADL disclosure constants — no invented D3/D5 numbers.
     */
    futures: router({
      policy: publicProcedure.query(() => describeFuturesPolicy({})),
    }),

    /**
     * Options product policy (trade.options / SOCKET §13).
     * Settlement asset law stamp required before listing — no invented live set.
     */
    options: router({
      policy: publicProcedure.query(() => describeOptionsPolicy()),
      ...optionsDeskProcedures(trade),
    }),

    /**
     * Copy trading (trade.copy / D-S-03 / SPEC-SOVEREIGN-ROUTING-AND-COPY).
     *
     * Follow / kill / unfollow are product-mounted. Blank DIRECTION §8 laws
     * refuse-closed — never invent leader_share_bps or jurisdiction allowlist.
     * Fee-share settle posts only via ledger-client when owner law is published.
     */
    copy: router({
      policy: publicProcedure.query(() => describeCopyPolicy()),

      deskStatus: scopedProcedure('trade:read', { module: 'trade' })
        .output(copyDeskStatusOutput)
        .query(() => (copy ? copy.deskStatus() : presentCustomerCopyDesk(unmountedCopyDeskFacts()))),

      opsStatus: scopedProcedure('admin:read')
        .output(copyOpsStatusOutput)
        .query(() => (copy ? copy.opsStatus() : presentCopyOpsStatus(unmountedCopyDeskFacts()))),

      follow: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            leaderId: z.string().min(1).max(120).optional(),
            leaderRef: z.string().min(1).max(80).optional(),
            region: z.string().min(1).max(16),
            permittedMarkets: z.array(z.string().min(1).max(64)).min(1).max(64),
            maxNotionalPerOrder: decimal,
            maxAggregateExposure: decimal,
            maxLoss: decimal.optional(),
            maxSlippageBps: z.number().int().min(1).max(10_000).optional(),
            maxConcurrent: z.number().int().min(1).max(2_147_483_647).optional(),
            maxDrawdown: decimal.optional(),
            maxLeverage: z.union([z.string(), z.number()]).optional(),
            expiresAt: z.string().datetime(),
            /** The request's own key: a second press with the same key returns the same follow. */
            clientRequestId: z.string().min(8).max(120),
            /** Quote amount each copied order uses. Omitted means no fixed size. */
            fixedOrderSize: decimal.optional(),
            leaderSettings: z
              .object({
                maxAllocation: decimal.optional(),
                permittedInstruments: z.array(z.string().min(1).max(64)).max(64).optional(),
                maxLoss: decimal.optional(),
                maxSlippageBps: z.number().int().min(1).max(10_000).optional(),
                maxConcurrent: z.number().int().min(1).max(2_147_483_647).optional(),
                maxDrawdown: decimal.optional(),
              })
              .optional(),
          }),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              logRefusalSpec('trade.copy_jurisdiction_blank');
              throw new CopyError(COPY_JURISDICTION_RESIDUAL, 'trade.copy_jurisdiction_blank', COPY_JURISDICTION_RESIDUAL);
            }
            return copy.startFollow(ctx.principal, input);
          }),
        ),

      unfollow: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.unfollow(ctx.principal, input);
          }),
        ),

      killFeeShare: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.killFeeShare(ctx.principal, input);
          }),
        ),

      grantSessionKey: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.grantSessionKey(ctx.principal, input);
          }),
        ),

      killSessionKey: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.killSessionKey(ctx.principal, input);
          }),
        ),

      pause: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .output(copyPauseOutput)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.pause(ctx.principal, input);
          }),
        ),

      stop: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64), closeOnly: z.boolean().optional() }))
        .output(copyStopOutput)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.stop(ctx.principal, input);
          }),
        ),

      detach: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .output(copyDetachOutput)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.detach(ctx.principal, input);
          }),
        ),

      flatten: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            followId: z.string().min(1).max(64),
            requestId: z.string().max(64).nullable().optional(),
            stepUpApprovalId: z.string().max(128).nullable().optional(),
          }),
        )
        .output(copyFlattenOutput)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.flatten(ctx.principal, input);
          }),
        ),

      resume: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .output(copyResumeOutput)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.resume(ctx.principal, input);
          }),
        ),

      /**
       * Published leader directory. Listed rows only, stable by listed time.
       * Limit is required. Any sort or order parameter is a ranking refuse.
       */
      listLeaders: scopedProcedure('trade:read', { module: 'trade' })
        .input(
          z
            .object({
              limit: z.number().optional(),
              cursor: z.string().max(500).optional(),
              sort: z.string().max(64).optional(),
              order: z.string().max(64).optional(),
              orderBy: z.string().max(64).optional(),
              return: z.string().max(64).optional(),
              profit: z.string().max(64).optional(),
              copiers: z.string().max(64).optional(),
              rank: z.string().max(64).optional(),
              // A ranked category or the trending row: accepted only so it can be refused by name (CB-copy-23).
              category: z.string().max(64).optional(),
              trending: z.boolean().optional(),
              marketMode: z.string().max(16).optional(),
              q: z.string().max(200).optional(),
            })
            .optional(),
        )
        .query(({ ctx, input }) =>
          guard(async () => {
            const query = input ?? {};
            refuseLeaderDirectoryRanking(query);
            publishedCopyPageLimit(query.limit, 'trade.copy_leaders_limit_unset', 'listLeaders');
            if (!copy) return { leaders: [], nextCursor: null };
            return copy.listLeaders(ctx.principal, query);
          }),
        ),

      /** One listed leader's page: listing facts and the metrics the owner defined. Not listed → NOT_FOUND. */
      leaderProfile: scopedProcedure('trade:read', { module: 'trade' })
        .input(z.object({ leaderRef: z.string().min(1).max(80) }))
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!copy) throw new CopyError('Leader not found', 'trade.copy_leader_not_found');
            return copy.leaderProfile(ctx.principal, input);
          }),
        ),

      /** One listed leader's own spot trades, newest first. Limit is required. */
      leaderTrades: scopedProcedure('trade:read', { module: 'trade' })
        .input(
          z.object({
            leaderRef: z.string().min(1).max(80),
            limit: z.number().optional(),
            cursor: z.string().max(64).optional(),
          }),
        )
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!copy) throw new CopyError('Leader not found', 'trade.copy_leader_not_found');
            return copy.leaderTrades(ctx.principal, input);
          }),
        ),

      /** The caller's copied orders on one of their follows, newest first. */
      followPositions: scopedProcedure('trade:read', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!copy) throw new CopyError('Follow not found', 'trade.copy_not_following');
            return copy.followPositions(ctx.principal, input);
          }),
        ),

      /** The caller's copied positions on one of their follows, newest first, with what is still open (CB-copy-09/10). */
      copiedPositions: scopedProcedure('trade:read', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!copy) throw new CopyError('Follow not found', 'trade.copy_not_following');
            return copy.copiedPositions(ctx.principal, input);
          }),
        ),

      /** Close one copied position, whole or by an amount (CB-copy-10). Once per close. */
      closeCopiedPosition: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            followId: z.string().min(1).max(64),
            positionId: z.string().min(1).max(64),
            qty: z.string().min(1).max(64).optional(),
          }),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) throw new CopyError('Follow not found', 'trade.copy_not_following');
            return copy.closePosition(ctx.principal, input);
          }),
        ),

      /** Leader fills this follow did not copy, with the reason id, newest first (CB-copy-11). */
      skipLog: scopedProcedure('trade:read', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!copy) throw new CopyError('Follow not found', 'trade.copy_not_following');
            return copy.skipLog(ctx.principal, input);
          }),
        ),

      /** Events for the caller's own follow, since the follow began. Limit is required. */
      followEvents: scopedProcedure('trade:read', { module: 'trade' })
        .input(
          z.object({
            followId: z.string().min(1).max(64),
            limit: z.number().optional(),
            cursor: z.string().max(500).optional(),
          }),
        )
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!copy) throw new CopyError('Follow not found', 'trade.copy_not_following');
            return copy.followEvents(ctx.principal, input);
          }),
        ),

      /** Apply to lead (CB-copy-12). One open application per person; the same submit again answers it. */
      applyToLead: scopedProcedure('trade:write', { module: 'trade' })
        // A blank name reaches the desk, which refuses it with its own code, so the room can say what to fix.
        .input(z.object({ displayName: z.string().max(200) }))
        .mutation(({ ctx, input }) => lead((desk) => desk.apply(ctx.principal, input))),

      /** The caller's newest lead application, or null. */
      myLeadApplication: scopedProcedure('trade:read', { module: 'trade' }).query(({ ctx }) => lead((desk) => desk.mine(ctx.principal))),

      ops: router({
        /** The founders' lead desk (CB-ops-01): the queue, the criteria, two-founder approval, rejection, leads, audit. */
        leadDesk: router({
          queue: scopedProcedure('admin:read', { module: 'trade' }).query(({ ctx }) => lead((desk) => desk.queue(ctx.principal))),
          leads: scopedProcedure('admin:read', { module: 'trade' }).query(({ ctx }) => lead((desk) => desk.leads(ctx.principal))),
          audit: scopedProcedure('admin:read', { module: 'trade' }).query(({ ctx }) => lead((desk) => desk.audit(ctx.principal))),
          setCriteria: scopedProcedure('admin:write', { module: 'trade' })
            .input(
              z
                .object({ minTrackRecordDays: z.number().int().min(0).max(3650), clientRequestId: z.string().trim().min(1).max(128) })
                .strict(),
            )
            .mutation(({ ctx, input }) => lead((desk) => desk.setCriteria(ctx.principal, input))),
          propose: scopedProcedure('admin:write', { module: 'trade' })
            .input(z.object({ applicationId: z.string().uuid(), approvalId: z.string().trim().min(1).max(128) }).strict())
            .mutation(({ ctx, input }) => lead((desk) => desk.propose(ctx.principal, input))),
          approve: scopedProcedure('admin:write', { module: 'trade' })
            .input(
              z
                .object({
                  applicationId: z.string().uuid(),
                  approvalId: z.string().trim().min(1).max(128),
                  operationId: z.string().trim().min(1).max(128),
                })
                .strict(),
            )
            .mutation(({ ctx, input }) => lead((desk) => desk.approve(ctx.principal, input))),
          reject: scopedProcedure('admin:write', { module: 'trade' })
            .input(z.object({ applicationId: z.string().uuid(), reason: z.string().min(3).max(500) }).strict())
            .mutation(({ ctx, input }) => lead((desk) => desk.reject(ctx.principal, input))),
        }),

        /** Operator writes need `admin:write`, the trade operator desk's write scope. */
        upsertListing: scopedProcedure('admin:write', { module: 'trade' })
          .input(
            z.object({
              clientRequestId: z.string().min(1).max(200),
              leaderUserId: z.string().min(1).max(120),
              displayName: z.string().min(1).max(200),
              marketMode: z.enum(['spot', 'futures', 'bot', 'signal']).optional(),
              recordKind: z.enum(['verified_live', 'paper', 'backtest', 'imported', 'self_reported']),
              state: z.enum(['unlisted', 'listed', 'suspended', 'delisted']).optional(),
              tenureStart: z.string().max(40).nullable().optional(),
              assets: z.array(z.string().min(1).max(32)).max(64).optional(),
              capacity: z.number().int().nonnegative().nullable().optional(),
              strategyVersion: z.string().max(120).nullable().optional(),
              publishedReturn: z.string().max(80).nullable().optional(),
              maximumDrawdown: z.string().max(80).nullable().optional(),
              windowStart: z.string().max(40).nullable().optional(),
              windowEnd: z.string().max(40).nullable().optional(),
              netOfCosts: z.boolean().nullable().optional(),
              evidenceRef: z.string().max(500).nullable().optional(),
            }),
          )
          .mutation(({ ctx, input }) =>
            guard(async () => {
              if (!copy) throw new CopyError('Copy trading is not available', 'trade.copy_law_blank');
              return copy.upsertListing(ctx.principal, input);
            }),
          ),

        setLeaderState: scopedProcedure('admin:write', { module: 'trade' })
          .input(
            z.object({
              leaderRef: z.string().min(1).max(80),
              state: z.enum(['listed', 'suspended', 'delisted']),
              reason: z.string().min(1).max(500),
              clientRequestId: z.string().min(1).max(200),
            }),
          )
          .mutation(({ ctx, input }) =>
            guard(async () => {
              if (!copy) throw new CopyError('Copy trading is not available', 'trade.copy_law_blank');
              return copy.setLeaderState(ctx.principal, input);
            }),
          ),
      }),

      /** Caller's follows only — product desk list. Omit limit → named refuse, never invent 50. */
      listMyFollows: scopedProcedure('trade:read', { module: 'trade' })
        .input(z.object({ limit: z.number().optional() }).optional())
        .query(({ ctx, input }) =>
          guard(async () => {
            const limit = publishedListMyFollowsLimit(input?.limit);
            if (!copy) return [];
            return copy.listMyFollows(ctx.principal, limit);
          }),
        ),

      /**
       * Detach follows in every closed region. Unpublished law = all regions.
       * Counts only — never another user's envelope. Never flattens or moves value.
       */
      closeFollowsInClosedRegions: scopedProcedure('trade:write', { module: 'trade' }).mutation(() =>
        guard(async () => {
          if (!copy) {
            return { scanned: 0, closed: 0, alreadyClosed: 0, stillOpen: 0, flattenInvented: false as const };
          }
          return copy.closeFollowsInClosedRegions();
        }),
      ),

      /**
       * Plan a mirror of a leader fill under one of the caller's follows.
       * Size/side/market come from the leader fill row — caller qty/notional
       * cannot invent a different shape. Envelope / cap / expiry refuse typed.
       * Does not place a spot order (auto-mirror execution is a separate residual).
       */
      planMirror: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            followId: z.string().min(1).max(64),
            fillId: z.string().min(1).max(120),
            marketId: z.string().min(1).max(64),
            side: z.enum(['buy', 'sell']),
            qty: decimal,
            notional: decimal,
            sessionLoss: decimal.optional(),
            leaderSettings: z
              .object({
                maxAllocation: decimal.optional(),
                permittedInstruments: z.array(z.string().min(1).max(64)).max(64).optional(),
                maxLoss: decimal.optional(),
                maxSlippageBps: z.number().int().min(1).max(10_000).optional(),
                maxConcurrent: z.number().int().min(1).max(2_147_483_647).optional(),
                maxDrawdown: decimal.optional(),
              })
              .optional(),
          }),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.planMirrorForFollow(ctx.principal, input);
          }),
        ),

      /**
       * Place a planned mirror into spot via follower placeOrder (limit at plan envelope).
       * TRADE_COPY_PLACE_MIRROR off / blank §8 / paper→live refuse by name.
       */
      placeMirror: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            followId: z.string().min(1).max(64),
            fillId: z.string().min(1).max(120),
            leaderPaper: z.boolean(),
          }),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('copy.placeMirror is refuse-closed until TRADE_COPY_PLACE_MIRROR is on', 'trade.copy_place_disabled');
            }
            return copy.placeMirrorForFollow(ctx.principal, input);
          }),
        ),

      /**
       * Attribute + settle leader fee-share for a follower fill.
       * Blank §8 → PRECONDITION_FAILED. Never invents rates.
       * `fillId` is the leader fill (mirror claim). `followerFillId` is the
       * follower's own fills row. protocolFee is that row's fee_amount —
       * never notional×bps or a caller fillFeeAmount. Missing fill row refuses.
       */
      settleFeeShare: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            followId: z.string().min(1).max(64),
            fillId: z.string().min(1).max(120),
            followerFillId: z.string().min(1).max(120).optional(),
            assetId: z.string().min(1).max(32),
            followerFillNotional: decimal,
            protocolFeeBps: z.number().int().min(0).max(10_000),
          }),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              logRefusalSpec('trade.copy_fee_share_blank');
              throw new CopyError(COPY_FEE_SHARE_RESIDUAL, 'trade.copy_fee_share_blank', COPY_FEE_SHARE_RESIDUAL);
            }
            return copy.settleFeeShare(ctx.principal, input);
          }),
        ),

      /**
       * Caller's own follow result. Fees and P&L are per quote asset.
       * Another account's follow id is not found.
       */
      result: scopedProcedure('trade:read', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
        .output(copyResultOutput)
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!copy) throw new CopyError('copy result is not mounted', 'trade.copy_unavailable');
            return copy.result(ctx.principal, input.followId);
          }),
        ),

      /**
       * Leader-intent trail for the caller's follow. Window and limit are
       * required. Oldest first.
       */
      mirrorTrail: scopedProcedure('trade:read', { module: 'trade' })
        .input(
          z.object({
            followId: z.string().min(1).max(64),
            from: z.string().optional(),
            to: z.string().optional(),
            limit: z.number().optional(),
            cursor: z.string().optional(),
          }),
        )
        .output(copyTrailOutput)
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!copy) throw new CopyError('copy trail is not mounted', 'trade.copy_unavailable');
            return copy.mirrorTrail(ctx.principal, input);
          }),
        ),
    }),

    scale: scaleProcedures(trade),
  });
}

function presentAlgo(parent: import('./algo/index.js').TwapParent) {
  return {
    id: parent.id,
    symbol: parent.symbol,
    side: parent.side,
    kind: parent.kind,
    totalQty: formatAmount(parent.totalQty),
    durationMs: parent.durationMs,
    sliceIntervalMs: parent.sliceIntervalMs,
    limitPrice: parent.limitPrice === null ? null : formatAmount(parent.limitPrice),
    status: parent.status,
    slicesPlanned: parent.slicesPlanned,
    nextSliceIndex: parent.nextSliceIndex,
    childrenEmitted: parent.children.length,
    missesRecorded: parent.misses.length,
    haltReason: parent.haltReason,
    stopReason: algoStopReason(parent),
    participationBps: parent.participationBps,
    povBasis: parent.povBasis ?? null,
    createdAt: parent.createdAt.toISOString(),
    startedAt: parent.startedAt.toISOString(),
    nextDueAt: parent.nextDueAt.toISOString(),
    projectedEndsAt: parent.projectedEndsAt.toISOString(),
    scheduleStretchReason: parent.scheduleStretchReason,
    randomSeed: parent.randomSeed ?? null,
    triggerPrice: parent.triggerPrice == null ? null : formatAmount(parent.triggerPrice),
    triggeredAt: parent.triggeredAt ? parent.triggeredAt.toISOString() : null,
    awaitingTrigger: awaitingTrigger(parent),
    ...presentChase(parent),
  };
}

export type TradeRouter = ReturnType<typeof createTradeRouter>;
