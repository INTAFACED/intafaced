import { z } from 'zod';
import { router, publicProcedure, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { AuthError } from '@intafaced/auth';
import { formatAmount, parseAmount, InsufficientFundsError, LedgerError } from '@intafaced/ledger-client';
import { orderSideSchema, timeInForceSchema } from '@intafaced/exchange-contract';
import { TradeError, type FillRecord, type Market, type OrderRecord } from './spot/types.js';
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
import { OtcError } from './otc/errors.js';
import { otcMakerRoutingStatus, OTC_MAKER_ROUTING_RESIDUAL } from './otc/maker-routing.js';
import { otcMidFeedStatus, OTC_MID_FEED_RESIDUAL } from './otc/mid-feed.js';
import type { OtcDeskService } from './otc/otc-service.js';
import { autoMirrorPlaceStatus, COPY_AUTO_MIRROR_PLACE_RESIDUAL } from './copy/auto-mirror-place.js';
import { COPY_FEE_SHARE_RESIDUAL, COPY_JURISDICTION_RESIDUAL, COPY_LAW_RESIDUAL, CopyError } from './copy/errors.js';
import { describeCopyPolicy } from './copy/copy-policy.js';
import { ListMyFollowsLimitUnsetError, publishedListMyFollowsLimit, type CopyService } from './copy/copy-service.js';
import { describeFuturesPolicy } from './futures/futures-policy.js';
import { describeOptionsPolicy } from './spot/options-policy.js';
import { describeOtcPolicy } from './otc/otc-policy.js';
import { describeAlgoPolicy } from './algo/algo-policy.js';
import { tradingControlsRouter } from './controls/router.js';
import { TradingControlError, type TradingControls } from './controls/trading-controls.js';

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

/** Shared TWAP parent presentation (create/get/pause/resume/cancel). */
const algoParentOutputSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  side: orderSideSchema,
  kind: z.enum(['twap', 'vwap', 'pov']),
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
  participationBps: z.number().int().nullable(),
  createdAt: z.string(),
  startedAt: z.string(),
  nextDueAt: z.string(),
  /** Projected wall-clock end after last re-space (ADR 2026-08-08). */
  projectedEndsAt: z.string(),
  /** Distinguishes user pause from tick outage; null until first stretch. */
  scheduleStretchReason: z.enum(['user_pause', 'tick_outage']).nullable(),
});

const marketOutput = z.object({
  id: z.string().uuid(),
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
});

const orderOutput = z.object({
  id: z.string().uuid(),
  clientOrderId: z.string().nullable(),
  marketId: z.string().uuid(),
  side: orderSideSchema,
  type: z.enum(['market', 'limit']),
  price: decimal.nullable(),
  qty: decimal,
  filled: decimal,
  remaining: decimal,
  status: z.enum(['pending', 'open', 'filled', 'cancelled', 'rejected', 'expired', 'recovery_required']),
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

const fillOutput = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  marketId: z.string().uuid(),
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
function toTrpcError(err: unknown): TRPCError {
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
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      case 'trade.otc_desk_law_blank':
      case 'trade.otc_settle_refused':
      case 'trade.otc_stake_unavailable':
      case 'trade.otc_no_reference_price':
      case 'trade.otc_bad_spread':
      case 'trade.rfq_allocation_refused':
      case 'trade.rfq_give_up_refused':
      case 'trade.rfq_missing_price':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof CopyError) {
    switch (err.code) {
      case 'trade.copy_not_following':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'trade.copy_jurisdiction_blocked':
      case 'trade.copy_self_follow':
      case 'trade.copy_fee_share_killed':
      case 'trade.copy_pnl_fee_forbidden':
      case 'trade.copy_ranking_forbidden':
      case 'trade.copy_leader_resume_forbidden':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      case 'trade.copy_fee_share_blank':
      case 'trade.copy_jurisdiction_blank':
      case 'trade.copy_law_blank':
      case 'trade.copy_settle_refused':
      case 'trade.copy_leader_fill_not_found':
      case 'trade.copy_auto_mirror_place_socket':
      case 'trade.copy_place_disabled':
      case 'trade.copy_session_key_missing':
      case 'trade.copy_session_key_revoked':
      case 'trade.copy_paused':
      case 'trade.copy_stopped':
      case 'trade.copy_detached':
      case 'trade.copy_flatten_refused':
      case 'trade.copy_flatten_drift':
      case 'trade.copy_flatten_unavailable':
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
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
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

  if (err instanceof AuthError) {
    return new TRPCError({ code: err.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN', message: err.message, cause: err });
  }

  if (err instanceof LedgerError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
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

export function createTradeRouter(trade: TradeService, otc?: OtcDeskService, copy?: CopyService, controls?: TradingControls) {
  return router({
    accountControls: tradingControlsRouter(controls),
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
       * THE MONEY PATH. `trade:write`, tier and jurisdiction, then the flow in
       * `TradeService.placeOrder`: risk → hold → engine → fill/release.
       */
      create: scopedProcedure('trade:write', { module: 'trade' })
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
              subAccountId: z.string().uuid().optional(),
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
        .mutation(({ ctx, input }) =>
          guard(async () =>
            presentOrder(
              await trade.placeOrder(ctx.principal, {
                symbol: input.symbol,
                side: input.side,
                type: input.type,
                qty: parseAmount(input.qty),
                price: input.price === undefined ? null : parseAmount(input.price),
                tif: input.timeInForce,
                clientOrderId: input.clientOrderId,
                subAccountId: input.subAccountId,
              }),
            ),
          ),
        ),

      /**
       * Cancelling is `trade:write` but is NOT gated on the market being
       * tradable or on the kill-switch. An operator who has halted a market
       * must still let users out; a control that traps funds is not a safety
       * control.
       */
      cancel: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ orderId: z.string().uuid() }))
        .output(orderOutput)
        .mutation(({ ctx, input }) => guard(async () => presentOrder(await trade.cancelOrder(ctx.principal, input.orderId)))),

      cancelAll: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ marketId: z.string().uuid().optional() }).optional())
        .output(z.array(orderOutput))
        .mutation(({ ctx, input }) => guard(async () => (await trade.cancelAllOrders(ctx.principal, input?.marketId)).map(presentOrder))),

      massCancel: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ marketId: z.string().uuid() }))
        .output(z.array(orderOutput))
        .mutation(({ ctx, input }) => guard(async () => (await trade.massCancelOrders(ctx.principal, input.marketId)).map(presentOrder))),

      get: scopedProcedure('trade:read')
        .input(z.object({ orderId: z.string().uuid() }))
        .output(orderOutput)
        .query(({ ctx, input }) => guard(async () => presentOrder(await trade.getOrder(ctx.principal, input.orderId)))),

      open: scopedProcedure('trade:read')
        .input(
          z
            .object({
              marketId: z.string().uuid().optional(),
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
            marketId: z.string().uuid().optional(),
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
            orderId: z.string().uuid(),
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
     * One-tap Convert (`trade.convert`) — firm RFQ. Book is the quote source;
     * accept settles exact in/out via ledger-client (not a matching order).
     */
    convert: router({
      quote: scopedProcedure('trade:read', { module: 'trade' })
        .input(
          z.object({
            symbol: z.string().min(3),
            side: orderSideSchema,
            qty: decimal,
          }),
        )
        .output(convertQuoteOutput)
        .query(({ ctx, input }) =>
          guard(async () =>
            trade.convertQuote(ctx.principal, {
              symbol: input.symbol,
              side: input.side,
              qty: parseAmount(input.qty),
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
    }),

    /**
     * OTC RFQ desk (trade.otc / D-S-02 Part A).
     * Default desk law unpublished → refuse-closed (DIRECTION §8). Never invents spread/stake.
     */
    otc: router({
      policy: publicProcedure.query(() => describeOtcPolicy()),

      deskStatus: scopedProcedure('trade:read', { module: 'trade' }).query(() => {
        if (!otc) {
          const deskLaw = 'DIRECTION §8 RFQ spreads, staked-tier threshold, and principal-vs-maker are owner-only — refuse-closed';
          return {
            published: false,
            statusLine: 'published=0 residual=DIRECTION_§8_refuse_closed',
            residual: deskLaw,
            makerRouting: otcMakerRoutingStatus(),
            midFeed: otcMidFeedStatus(),
            residuals: {
              deskLaw,
              makerRouting: OTC_MAKER_ROUTING_RESIDUAL,
              midFeed: OTC_MID_FEED_RESIDUAL,
            },
          };
        }
        return otc.deskStatus();
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
              quoteId: z.string().uuid(),
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
        .input(z.object({ quoteId: z.string().uuid() }).strict())
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.settle(ctx.principal, { quoteId: input.quoteId });
          }),
        ),
    }),

    /**
     * Professional RFQ (PTX-M12) — firm quote/accept/expire on the OTC desk.
     * Size required; desk names the price (no mid on the wire). Not a book fill.
     */
    rfq: router({
      quote: scopedProcedure('trade:read', { module: 'trade' })
        .input(
          z
            .object({
              side: orderSideSchema,
              baseAsset: z.string().min(1).max(32),
              quoteAsset: z.string().min(1).max(32),
              qty: z.string(),
              makerId: z.string().min(1).max(120).optional(),
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
            });
          }),
        ),

      accept: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ quoteId: z.string().uuid(), assertedPrice: decimal.optional() }).strict())
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
        .input(z.object({ quoteId: z.string().uuid() }).strict())
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.rfqExpire(ctx.principal, { quoteId: input.quoteId });
          }),
        ),

      get: scopedProcedure('trade:read', { module: 'trade' })
        .input(z.object({ quoteId: z.string().uuid() }).strict())
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!otc) throw new OtcError('OTC desk not mounted', 'trade.otc_desk_law_blank');
            return otc.rfqGet(ctx.principal, input.quoteId);
          }),
        ),

      allocate: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ quoteId: z.string().uuid(), allocations: z.array(z.unknown()).min(1) }).strict())
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
              quoteId: z.string().uuid(),
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
      policy: publicProcedure.query(() => describeAlgoPolicy()),

      createTwap: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            symbol: z.string().min(3),
            side: orderSideSchema,
            totalQty: decimal,
            durationMs: z.number().int().min(1_000).max(86_400_000),
            sliceIntervalMs: z.number().int().min(1_000).max(86_400_000),
            limitPrice: decimal.optional(),
            clientAlgoId: z.string().min(1).max(48).optional(),
            subAccountId: z.string().uuid().optional(),
            kind: z.enum(['twap', 'vwap', 'pov']).optional(),
            participationBps: z.number().int().min(1).max(10_000).optional(),
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
            });
            return presentAlgo(parent);
          }),
        ),

      get: scopedProcedure('trade:read')
        .input(z.object({ algoId: z.string().min(1) }))
        .output(algoParentOutputSchema)
        .query(({ ctx, input }) => guard(async () => presentAlgo(await trade.getAlgo(ctx.principal, input.algoId)))),

      progress: scopedProcedure('trade:read')
        .input(z.object({ algoId: z.string().min(1) }))
        .output(
          z.object({
            parentId: z.string(),
            status: z.enum(['active', 'paused', 'cancelled', 'completed', 'halted']),
            haltReason: z.string().nullable(),
            childrenEmitted: z.number().int(),
            missesRecorded: z.number().int(),
            slicesPlanned: z.number().int(),
            nextSliceIndex: z.number().int(),
            filledQty: decimal,
            totalQty: decimal,
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

      deskStatus: scopedProcedure('trade:read', { module: 'trade' }).query(() => {
        if (!copy) {
          return {
            sovereign: {
              shape: 'sovereign' as const,
              custody: false,
              feeModel: 'protocol_fee_share' as const,
              pnlFeeForbidden: true,
              rankingForbidden: true,
              killUnfollowReal: true,
            },
            feeSharePublished: false,
            leaderShareBps: null,
            jurisdictionPublished: false,
            statusLine: 'feeShare=0 residual=D26-P0-02_leader_share_bps jurisdiction=0 residual=D26-P0-15_jurisdiction',
            residual: COPY_LAW_RESIDUAL,
            residuals: {
              rates: COPY_FEE_SHARE_RESIDUAL,
              jurisdiction: COPY_JURISDICTION_RESIDUAL,
              autoMirrorPlace: COPY_AUTO_MIRROR_PLACE_RESIDUAL,
            },
            autoMirrorPlace: autoMirrorPlaceStatus(false),
          };
        }
        return copy.deskStatus();
      }),

      follow: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            leaderId: z.string().min(1).max(120),
            region: z.string().min(1).max(16),
            permittedMarkets: z.array(z.string().min(1).max(64)).min(1).max(64),
            maxNotionalPerOrder: decimal,
            maxAggregateExposure: decimal,
            maxLoss: decimal.optional(),
            expiresAt: z.string().datetime(),
            leaderSettings: z
              .object({
                maxAllocation: decimal.optional(),
                permittedInstruments: z.array(z.string().min(1).max(64)).max(64).optional(),
                maxLoss: decimal.optional(),
              })
              .optional(),
          }),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError(
                'Copy is refuse-closed until owner publishes DIRECTION §8 / D26-P0-15 served-jurisdiction list',
                'trade.copy_jurisdiction_blank',
                COPY_JURISDICTION_RESIDUAL,
              );
            }
            return copy.follow(ctx.principal, input);
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
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.pause(ctx.principal, input);
          }),
        ),

      stop: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
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
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.detach(ctx.principal, input);
          }),
        ),

      flatten: scopedProcedure('trade:write', { module: 'trade' })
        .input(z.object({ followId: z.string().min(1).max(64) }))
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
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError('Follow not found', 'trade.copy_not_following');
            }
            return copy.resume(ctx.principal, input);
          }),
        ),

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
       * protocolFee is the fill's fee_amount from lookup — never notional×bps
       * or a caller fillFeeAmount. Missing fill row refuses.
       */
      settleFeeShare: scopedProcedure('trade:write', { module: 'trade' })
        .input(
          z.object({
            followId: z.string().min(1).max(64),
            fillId: z.string().min(1).max(120),
            assetId: z.string().min(1).max(32),
            followerFillNotional: decimal,
            protocolFeeBps: z.number().int().min(0).max(10_000),
          }),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            if (!copy) {
              throw new CopyError(
                'Copy fee-share is refuse-closed until owner publishes DIRECTION §8 / D26-P0-02 leader_share_bps',
                'trade.copy_fee_share_blank',
                COPY_FEE_SHARE_RESIDUAL,
              );
            }
            return copy.settleFeeShare(ctx.principal, input);
          }),
        ),
    }),
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
    participationBps: parent.participationBps,
    createdAt: parent.createdAt.toISOString(),
    startedAt: parent.startedAt.toISOString(),
    nextDueAt: parent.nextDueAt.toISOString(),
    projectedEndsAt: parent.projectedEndsAt.toISOString(),
    scheduleStretchReason: parent.scheduleStretchReason,
  };
}

export type TradeRouter = ReturnType<typeof createTradeRouter>;
