import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, requireScope } from '@intafaced/auth';
import { checkAccess, screeningFailClosedFromEnv } from '@intafaced/config';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { formatAmount, mul, mulBps, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { MarketAction } from '@intafaced/exchange-contract';
import type { MarketLifecyclePort } from '../market-lifecycle.js';
import {
  assertMarketOpen,
  assertNotional,
  assertPrice,
  assertQty,
  assertSettlementRails,
  assertTradable,
  holdFor,
  protectionPriceFor,
  requireSupportedType,
  sellProtectionPriceFor,
} from './risk.js';
import { assertStopTrigger, TRADE_STOP_TRIGGER_INVALID } from './stop-trigger-door.js';
import { STOP_MARKET, stopMarketLimit } from './stop-market.js';
import { validateSlippageTolerance } from './slippage-tolerance.js';
import {
  FEE_SCHEDULE_RESIDUAL,
  FeeScheduleError,
  REGULAR_FEE_TIER,
  makerRebateBpsFor,
  previewFeeBps,
  type OwnerFeeSchedule,
} from './fee-schedule.js';
import { TradeError, type Market, type OrderSide, type OrderType, type TimeInForce } from './types.js';
import type { EdgeTrust } from '../edge-trust.js';
import { privateWrite } from '../route-inventory.js';

export const SPOT_ORDER_PREVIEW_PATH = '/api/v1/orders/preview';

export interface SpotOrderPreviewRefusal {
  code: string;
  field:
    | 'symbol'
    | 'type'
    | 'side'
    | 'amount'
    | 'price'
    | 'timeInForce'
    | 'expireAt'
    | 'holdAmount'
    | 'fee'
    | 'protectionPrice'
    | 'region'
    | 'stopPrice'
    | 'exit';
  message: string;
  /** Exact decimal strings the refusal names (a price band's edges, an open-order cap and count). Absent otherwise. */
  data?: Record<string, string>;
}

/** The fee a linked exit leg would post if it filled: the take-profit rests (maker), the stop-loss takes. */
export interface SpotOrderPreviewExitLegFee {
  /** Price the estimate is figured at: the take-profit price, or the stop trigger (its limit for a buy). */
  price: string;
  feeRole: 'maker' | 'taker';
  feeBps: number;
  estimatedFee: string;
  feeAsset: string;
}

export interface SpotOrderPreviewExitFees {
  /** Side the exit legs trade: the order's side for an OCO, the opposite for a bracket's exit. */
  side: 'buy' | 'sell';
  takeProfit: SpotOrderPreviewExitLegFee;
  stopLoss: SpotOrderPreviewExitLegFee;
}

export interface SpotOrderPreviewWire {
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  amount: string;
  price: string | null;
  /** The trigger of a stop-limit; null for every other type. */
  stopPrice: string | null;
  timeInForce: TimeInForce;
  /** Asset that placeOrder would reserve. Null when the hold cannot be named. */
  holdAsset: string | null;
  /** Decimal string of the reservation. Paper places post `'0'`. */
  holdAmount: string | null;
  protectionPrice: string | null;
  /** Owner-schedule maker/taker bps applied as preview — never invented. */
  estimatedFee: string | null;
  feeAsset: string | null;
  feeBps: number | null;
  feeRole: 'maker' | 'taker' | null;
  /** Owner schedule version. Null when the schedule is unpublished. */
  feeScheduleVersion: string | null;
  /** The fee tier the rates above are for: the one an order placed now would keep. */
  feeTier: string;
  /** Discounted maker bps the fill would post if this order rests. */
  makerFeeBps: number | null;
  /** Discounted taker bps the fill would post if this order takes. */
  takerFeeBps: number | null;
  /**
   * The maker rebate this market's row publishes, in bps of what the maker pays, if this order rests: 0 = none, null
   * = not known (no row). Up to: the ledger pays it from each fill's own taker fee, so it is held below that rate.
   */
  makerRebateBps: number | null;
  /** Fees of the linked exit legs when the request carries `exit`; null otherwise or when a leg cannot be figured. */
  exitFees: SpotOrderPreviewExitFees | null;
  orderable: boolean;
  refusals: SpotOrderPreviewRefusal[];
}

export interface SpotOrderPreviewRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  now(): Date;
  marketBySymbol(symbol: string): Promise<Market | null>;
  /** PX-S01 admission. Null is a typed refusal, not OPEN. */
  marketLifecycle: MarketLifecyclePort | null;
  /**
   * Best ask for market-buy protection only. Absent/null → `trade.no_reference_price`.
   * This is a depth peek — never submit.
   */
  bestAsk?(marketId: string): Promise<Amount | null>;
  /** Best bid for market-sell protection. Absent/null → `trade.no_reference_price`. */
  bestBid?(marketId: string): Promise<Amount | null>;
  /**
   * Matching's operator halt of this market, or of the whole venue (its public board). A halted book refuses every
   * new submit with `market_halted`, so the preview says so before Confirm. Absent or a failed read adds nothing:
   * place stays the authority and refuses on its own.
   */
  matchingHalt?(marketId: string): Promise<{ readonly market: boolean; readonly venue: boolean }>;
  /**
   * The operator limits place enforces (`assertOperatorRiskOnPlace`), bound to this service's store and book. A
   * TradeError becomes a refusal row with its data. Absent in tests means no operator limits.
   */
  operatorRisk?(
    market: Market,
    userId: string,
    input: { readonly side: OrderSide; readonly price: Amount | null; readonly qty: Amount; readonly rests: boolean },
  ): Promise<void>;
  /** True when the stop-trigger store is wired, the same condition under which placement accepts `stop_limit`. */
  stopLimitEnabled?: boolean;
  spotEnabled: boolean;
  futuresEnabled: boolean;
  optionsSettlementLawStamped: boolean;
  /** Null/unset → market-buy preview refuses `trade.slippage_cap_unset`. */
  slippageCapBps: number | null;
  /**
   * The cap a stop-market on this market is placed at (the operator's per-market cap, else the env cap), the same one
   * placement reads. Absent: the env cap above.
   */
  stopMarketCapBps?: (marketId: string) => Promise<number | null>;
  /** PTX-M21 owner fee/rebate schedule. Unpublished → typed refuse, never invent bps. */
  feeSchedule: OwnerFeeSchedule;
  /** The schedule in force now (a later approved version, else `feeSchedule`). Absent: `feeSchedule` as booted. */
  feeScheduleNow?: () => Promise<OwnerFeeSchedule>;
  /**
   * Snapshotted rank discount, the same read place uses. Absent in tests means
   * zero. A failure refuses the fee rather than showing a rate the fill will not post.
   */
  feeDiscountBps?(userId: string): Promise<number>;
  /** The fee tier an order placed now would take, the same read place uses. Absent in tests means regular. */
  feeTier?(userId: string): Promise<string>;
}

const ALLOWED_FIELDS = new Set([
  'symbol',
  'side',
  'type',
  'amount',
  'price',
  'stopPrice',
  'exit',
  'maxSlippageBps',
  'timeInForce',
  'expireAt',
  'postOnly',
  'reduceOnly',
  'clientOrderId',
  'subAccountId',
]);

const LIFECYCLE_CODES = new Set([
  'trade.market_halted',
  'trade.market_suspended',
  'trade.lifecycle_authority_unavailable',
  'trade.lifecycle_dossier_required',
  'trade.lifecycle_dossier_invalid',
  'trade.lifecycle_readiness_socket',
  'trade.lifecycle_transition_partial',
  'trade.lifecycle_transition_unknown',
  'trade.lifecycle_recovery_required',
  'trade.product_disabled',
  'trade.matching_market_missing',
  'trade.matching_unavailable',
  'trade.lifecycle_wrong_market',
  'trade.market_status_unknown',
  'trade.lifecycle_authority_stale',
  'trade.market_closed',
  'trade.unknown_schedule',
]);

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

function parsePositive(value: string): Amount | null {
  try {
    const parsed = parseAmount(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

function pushError(refusals: SpotOrderPreviewRefusal[], error: unknown, field: SpotOrderPreviewRefusal['field']): void {
  if (error instanceof TradeError) {
    refusals.push({ code: error.code, field, message: error.message, ...(error.data ? { data: { ...error.data } } : {}) });
    return;
  }
  throw error;
}

/**
 * Read-only spot place preview. This route never receives a ledger port and
 * never calls matching submit — hold/fee figures are the same formulas
 * `placeOrder` would use, or blank with a typed refusal.
 */
export function registerSpotOrderPreviewRest(app: FastifyInstance, deps: SpotOrderPreviewRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

  app.post(SPOT_ORDER_PREVIEW_PATH, privateWrite, async (req, reply) => {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    const edge = edgeContext(edgeReq);
    const principal = edge.principal;
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:read');
    } catch (error) {
      if (error instanceof AuthError) return sendError(reply, 403, 'trade.permission_denied', error.message);
      throw error;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const suppliedServerValues = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
    if (suppliedServerValues.length > 0) {
      return sendError(
        reply,
        400,
        'trade.order_preview_server_values_only',
        `preview values are server-authored; unsupported fields: ${suppliedServerValues.sort().join(', ')}`,
      );
    }

    const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : '';
    const side: OrderSide | null = body.side === 'buy' || body.side === 'sell' ? body.side : null;
    const typeWire = typeof body.type === 'string' ? body.type.trim() : '';
    const amountWire = typeof body.amount === 'string' ? body.amount.trim() : '';
    let priceWire = body.price === undefined ? null : typeof body.price === 'string' ? body.price.trim() : '';
    if (
      !symbol ||
      !side ||
      !typeWire ||
      amountWire === '' ||
      typeof body.amount !== 'string' ||
      (body.price !== undefined && typeof body.price !== 'string') ||
      (body.stopPrice !== undefined && typeof body.stopPrice !== 'string')
    ) {
      return sendError(
        reply,
        400,
        'trade.order_preview_invalid',
        'symbol, side, type, and positive decimal-string amount are required (price/stopPrice if present must be decimal strings)',
      );
    }
    const qty = parsePositive(amountWire);
    if (qty === null) {
      return sendError(reply, 400, 'trade.order_preview_invalid', 'amount must be a positive decimal string');
    }
    if (body.reduceOnly === true) {
      return sendError(reply, 400, 'trade.order_type_unsupported', 'reduceOnly is not supported on spot');
    }

    const market = await deps.marketBySymbol(symbol);
    if (!market) {
      return sendError(reply, 404, 'trade.market_not_found', 'market is not listed');
    }

    let tif: TimeInForce =
      body.timeInForce === 'IOC' ||
      body.timeInForce === 'FOK' ||
      body.timeInForce === 'PO' ||
      body.timeInForce === 'MOC' ||
      body.timeInForce === 'GTD' ||
      body.timeInForce === 'GTC'
        ? body.timeInForce
        : 'GTC';
    if (body.postOnly === true) {
      if (tif !== 'GTC' && tif !== 'PO') {
        return sendError(reply, 400, 'trade.invalid_price', 'postOnly cannot be combined with an immediate time-in-force');
      }
      tif = 'PO';
    }

    const refusals: SpotOrderPreviewRefusal[] = [];
    if (tif === 'MOC') {
      refusals.push({
        code: 'trade.invalid_tif',
        field: 'timeInForce',
        message: 'maker-or-cancel is not yet accepted by the trade service',
      });
    }
    // Good-till-date rests at a limit price until the caller's instant; the service never invents one.
    const expireWire = body.expireAt === undefined ? null : typeof body.expireAt === 'string' ? body.expireAt.trim() : '';
    if (tif === 'GTD') {
      const expiresAt = expireWire === null || expireWire === '' ? null : Date.parse(expireWire);
      if (expireWire === null || expireWire === '') {
        refusals.push({ code: 'trade.missing_expire_at', field: 'expireAt', message: 'a good-till-date order needs an expiry' });
      } else if (expiresAt === null || Number.isNaN(expiresAt)) {
        refusals.push({ code: 'trade.invalid_tif', field: 'expireAt', message: 'the expiry must be a date and time in the future' });
      } else if (expiresAt <= deps.now().getTime()) {
        // The same code the place door refuses a spent expiry with, so a preview and a send never disagree on it.
        refusals.push({ code: 'trade.invalid_expiry', field: 'expireAt', message: 'the expiry must be a date and time in the future' });
      }
      if (typeWire !== 'limit') {
        refusals.push({ code: 'trade.invalid_tif', field: 'timeInForce', message: 'good-till-date needs a limit price to rest at' });
      }
    } else if (expireWire !== null) {
      refusals.push({ code: 'trade.invalid_tif', field: 'expireAt', message: 'an expiry only applies to a good-till-date order' });
    }
    // A stop-market (`stop`) is previewed as the stop-limit it is placed as, at its protection price (spot/stop-market.ts).
    const isStopMarket = typeWire === STOP_MARKET && deps.stopLimitEnabled === true;
    const isStopLimit = (typeWire === 'stop_limit' || isStopMarket) && deps.stopLimitEnabled === true;
    if (isStopMarket && priceWire !== null) {
      refusals.push({ code: 'trade.invalid_price', field: 'price', message: 'a stop-market is priced by the market: send no price' });
    }
    let orderType: OrderType | null = null;
    try {
      orderType = isStopLimit ? 'limit' : requireSupportedType(typeWire);
    } catch (error) {
      pushError(refusals, error, 'type');
    }
    if (tif === 'PO' && orderType !== null && orderType !== 'limit') {
      refusals.push({ code: 'trade.invalid_price', field: 'price', message: 'post-only requires a limit price' });
    }

    if (!deps.spotEnabled && market.kind === 'spot') {
      refusals.push({
        code: 'trade.spot_disabled',
        field: 'symbol',
        message: 'spot trading is disabled by the operator kill-switch',
      });
    }
    if (!deps.spotEnabled && !deps.futuresEnabled) {
      refusals.push({
        code: 'trade.spot_disabled',
        field: 'symbol',
        message: 'spot trading is disabled by the operator kill-switch',
      });
    }

    try {
      assertTradable(market, {
        futuresEnabled: deps.futuresEnabled,
        optionsSettlementLawStamped: deps.optionsSettlementLawStamped,
        now: deps.now(),
      });
    } catch (error) {
      pushError(refusals, error, 'symbol');
    }
    try {
      assertSettlementRails(market);
    } catch (error) {
      pushError(refusals, error, 'symbol');
    }
    try {
      assertMarketOpen(market, deps.now());
    } catch (error) {
      pushError(refusals, error, 'symbol');
    }

    const halt = deps.matchingHalt ? await deps.matchingHalt(market.id).catch(() => null) : null;
    if (halt?.venue) {
      refusals.push({ code: 'trade.venue_halted', field: 'symbol', message: 'an operator has halted new orders on every market' });
    } else if (halt?.market) {
      refusals.push({ code: 'trade.market_halted', field: 'symbol', message: `an operator has halted new orders on ${market.symbol}` });
    }

    const action: MarketAction = tif === 'PO' ? 'PLACE_POST_ONLY' : 'PLACE';
    if (!deps.marketLifecycle) {
      refusals.push({
        code: 'trade.lifecycle_authority_unavailable',
        field: 'symbol',
        message: 'market lifecycle authority is not configured',
      });
    } else {
      const snapshot = await deps.marketLifecycle.snapshot(market, { now: deps.now().toISOString() });
      const decision = deps.marketLifecycle.admit(snapshot, action);
      if (decision.decision !== 'ELIGIBLE') {
        const code = LIFECYCLE_CODES.has(decision.reasonCode ?? '')
          ? (decision.reasonCode as string)
          : 'trade.lifecycle_authority_unavailable';
        refusals.push({
          code,
          field: 'symbol',
          message: `market ${market.symbol} lifecycle refuses ${action}: ${decision.reasonCode ?? snapshot.state}`,
        });
      }
      if (decision.decision === 'ELIGIBLE' && snapshot.state === 'LIMIT_ONLY' && typeWire === 'market') {
        refusals.push({
          code: 'trade.mode_limit_only',
          field: 'type',
          message: `market ${market.symbol} is limit-only: market orders are refused`,
        });
      }
    }

    try {
      assertQty(market, qty);
    } catch (error) {
      pushError(refusals, error, 'amount');
    }

    let stopTrigger: Amount | null = null;
    if (isStopLimit) {
      const stopWire = typeof body.stopPrice === 'string' ? body.stopPrice.trim() : '';
      const parsedStop = stopWire === '' ? null : parsePositive(stopWire);
      if (parsedStop === null) {
        refusals.push({ code: TRADE_STOP_TRIGGER_INVALID, field: 'stopPrice', message: 'a stop-limit requires a positive stopPrice' });
      } else {
        try {
          assertStopTrigger(parsedStop, market.tickSize);
          stopTrigger = parsedStop;
        } catch (error) {
          pushError(refusals, error, 'stopPrice');
        }
        if (isStopMarket && stopTrigger !== null && priceWire === null) {
          try {
            const cap = deps.stopMarketCapBps ? await deps.stopMarketCapBps(market.id) : deps.slippageCapBps;
            priceWire = formatAmount(stopMarketLimit(market, side, stopTrigger, cap));
          } catch (error) {
            pushError(refusals, error, 'stopPrice');
          }
        }
      }
      if (tif !== 'GTC') {
        refusals.push({
          code: 'trade.invalid_tif',
          field: 'timeInForce',
          message: 'a stop-limit rests until triggered: use good-till-cancelled',
        });
      }
    } else if (body.stopPrice !== undefined) {
      refusals.push({
        code: TRADE_STOP_TRIGGER_INVALID,
        field: 'stopPrice',
        message: 'a stop is placed as type stop_limit with a stopPrice',
      });
    }

    let limitPrice: Amount | null = null;
    if (orderType === 'limit') {
      if (priceWire === null || priceWire === '') {
        refusals.push({ code: 'trade.invalid_price', field: 'price', message: 'a limit order requires a price' });
      } else {
        const parsed = parsePositive(priceWire);
        if (parsed === null) {
          refusals.push({ code: 'trade.invalid_price', field: 'price', message: 'price must be a positive decimal string' });
        } else {
          try {
            assertPrice(market, parsed);
            assertNotional(market, parsed, qty);
            limitPrice = parsed;
          } catch (error) {
            pushError(refusals, error, 'price');
          }
        }
      }
    } else if (priceWire !== null) {
      refusals.push({ code: 'trade.invalid_price', field: 'price', message: 'a market order must not carry a price' });
    }

    // The operator's limits for this market (fat finger, price band, open-order cap), the same gate place runs, so a
    // price outside the band or a full cap is said before Confirm. A limit order is judged only once its price reads.
    if (deps.operatorRisk && !market.paper && orderType !== null && (orderType !== 'limit' || limitPrice !== null)) {
      try {
        await deps.operatorRisk(market, principal.userId, {
          side,
          price: orderType === 'limit' ? limitPrice : null,
          qty,
          rests: orderType === 'limit' && tif !== 'IOC' && tif !== 'FOK',
        });
      } catch (error) {
        pushError(
          refusals,
          error,
          error instanceof TradeError && (error.code === 'trade.operator_throttle' || error.code === 'trade.open_orders_cap_unset')
            ? 'symbol'
            : 'price',
        );
      }
    }

    let protectionPrice: Amount | null = null;
    let fundingPrice: Amount | null = limitPrice;
    const needsBestAsk =
      (orderType === 'market' && side === 'buy') ||
      (orderType === 'limit' && side === 'buy' && (tif === 'GTC' || tif === 'GTD') && limitPrice !== null);
    const bestAsk = needsBestAsk && deps.bestAsk ? await deps.bestAsk(market.id) : null;
    if (orderType === 'market' && side === 'buy') {
      try {
        protectionPrice = protectionPriceFor(market, bestAsk, deps.slippageCapBps);
        const tolerance = validateSlippageTolerance(body.maxSlippageBps, orderType, deps.slippageCapBps);
        if (tolerance !== null) {
          const tighter = protectionPriceFor(market, bestAsk, tolerance);
          if (tighter < protectionPrice) protectionPrice = tighter;
        }
        assertNotional(market, protectionPrice, qty);
        fundingPrice = protectionPrice;
      } catch (error) {
        pushError(refusals, error, 'protectionPrice');
      }
    } else if (orderType === 'market' && side === 'sell') {
      const bid = deps.bestBid ? await deps.bestBid(market.id) : null;
      try {
        protectionPrice = sellProtectionPriceFor(market, bid ?? null, deps.slippageCapBps);
        const tolerance = validateSlippageTolerance(body.maxSlippageBps, orderType, deps.slippageCapBps);
        if (tolerance !== null) {
          const tighter = sellProtectionPriceFor(market, bid ?? null, tolerance);
          if (tighter > protectionPrice) protectionPrice = tighter;
        }
        fundingPrice = 0n;
      } catch (error) {
        pushError(refusals, error, 'protectionPrice');
      }
    } else if (orderType !== null) {
      try {
        validateSlippageTolerance(body.maxSlippageBps, orderType, deps.slippageCapBps);
      } catch (error) {
        pushError(refusals, error, 'protectionPrice');
      }
    }

    let holdAsset: string | null = null;
    let holdAmount: Amount | null = null;
    if (orderType !== null && (orderType === 'limit' ? limitPrice !== null : fundingPrice !== null)) {
      if (market.paper) {
        holdAsset = side === 'buy' ? market.quoteAsset : market.baseAsset;
        holdAmount = 0n;
      } else {
        const hold = holdFor(market, side, fundingPrice ?? 0n, qty);
        holdAsset = hold.assetId;
        holdAmount = hold.amount;
      }
    }

    let discountBps = 0;
    let discountKnown = true;
    if (deps.feeDiscountBps) {
      try {
        discountBps = await deps.feeDiscountBps(principal.userId);
      } catch (error) {
        discountKnown = false;
        if (error instanceof TradeError) pushError(refusals, error, 'fee');
        else {
          refusals.push({ code: 'trade.perks_unavailable', field: 'fee', message: 'rank discount is unavailable' });
        }
      }
    }

    // As placement reads it: a sub-account order and anything but spot are regular.
    let feeTier: string = REGULAR_FEE_TIER;
    if (deps.feeTier && market.kind === 'spot' && !market.paper && body.subAccountId == null) {
      try {
        feeTier = await deps.feeTier(principal.userId);
      } catch {
        discountKnown = false;
        refusals.push({ code: 'trade.fee_tier_unavailable', field: 'fee', message: 'fee tier is unavailable' });
      }
    }

    // A stop-limit's role is unknown until it triggers, so the preview shows the taker (worst-case) fee.
    const takes =
      orderType !== null &&
      (isStopLimit ||
        !(
          orderType === 'limit' &&
          (tif === 'PO' ||
            tif === 'MOC' ||
            ((tif === 'GTC' || tif === 'GTD') && side === 'buy' && limitPrice !== null && bestAsk !== null && limitPrice < bestAsk))
        ));
    const rests = orderType === 'limit' && !takes;
    const feeRole: 'maker' | 'taker' | null = orderType === null ? null : rests ? 'maker' : 'taker';
    // A schedule row that refuses (no row, rebate or minimum with no recipe) leaves the fee unavailable, never a guess.
    const scheduleNow = deps.feeScheduleNow ? await deps.feeScheduleNow() : deps.feeSchedule;
    // The code a refusing row gave (no row for this market's pair group, say), so the refusal names it.
    let feeRowRefusal: FeeScheduleError | null = null;
    const feeBpsFor = (role: 'maker' | 'taker'): number | null => {
      if (!discountKnown) return null;
      try {
        return previewFeeBps(scheduleNow, role, discountBps, { symbol: market.symbol, tierId: feeTier });
      } catch (err) {
        if (err instanceof FeeScheduleError) {
          feeRowRefusal ??= err;
          return null;
        }
        throw err;
      }
    };
    const makerFeeBps = feeBpsFor('maker');
    const takerFeeBps = feeBpsFor('taker');
    // Same row as the maker rate above, so it is known exactly when that rate is.
    const makerRebateBps = makerFeeBps === null ? null : makerRebateBpsFor(scheduleNow, { symbol: market.symbol, tierId: feeTier });
    const feeScheduleVersion = scheduleNow.published === true ? scheduleNow.version : null;
    const feeBps = feeRole === null ? null : feeRole === 'maker' ? makerFeeBps : takerFeeBps;
    let estimatedFee: Amount | null = null;
    let feeAsset: string | null = null;
    if (feeRole === null) {
      // type already refused
    } else if (feeBps === null) {
      // A blank schedule, or a row that refuses for this market, names the same code the order path refuses with, in
      // plain words (the schedule's own message names its env key and internal ids). An unknown rank discount is
      // the remaining case.
      const rowRefusal = feeRowRefusal as FeeScheduleError | null;
      refusals.push(
        rowRefusal
          ? { code: rowRefusal.code, field: 'fee', message: rowRefusal.residual }
          : scheduleNow.published !== true
            ? { code: 'trade.fee_schedule_blank', field: 'fee', message: FEE_SCHEDULE_RESIDUAL }
            : { code: 'trade.order_preview_fee_unavailable', field: 'fee', message: 'published fee schedule is unavailable' },
      );
    } else if (
      orderType === 'limit'
        ? limitPrice !== null
        : fundingPrice !== null && (orderType !== 'market' || side === 'sell' || protectionPrice !== null)
    ) {
      const notionalPrice = orderType === 'limit' ? limitPrice : (protectionPrice ?? fundingPrice);
      if (notionalPrice !== null && notionalPrice > 0n) {
        const quoteAmount = mul(notionalPrice, qty, 'floor');
        if (side === 'buy') {
          estimatedFee = mulBps(qty, feeBps, 'ceil');
          feeAsset = market.baseAsset;
        } else {
          estimatedFee = mulBps(quoteAmount, feeBps, 'ceil');
          feeAsset = market.quoteAsset;
        }
      }
    }

    let exitFees: SpotOrderPreviewExitFees | null = null;
    if (body.exit !== undefined && body.exit !== null) {
      const exit = body.exit as Record<string, unknown>;
      const kind = exit !== null && typeof exit === 'object' ? exit.kind : undefined;
      const takeProfit = typeof exit.takeProfit === 'string' ? parsePositive(exit.takeProfit.trim()) : null;
      const stopLoss = typeof exit.stopLoss === 'string' ? parsePositive(exit.stopLoss.trim()) : null;
      const stopLimit = typeof exit.stopLossLimit === 'string' ? parsePositive(exit.stopLossLimit.trim()) : null;
      if (
        (kind !== 'oco' && kind !== 'bracket_exit') ||
        takeProfit === null ||
        stopLoss === null ||
        (exit.stopLossLimit != null && stopLimit === null)
      ) {
        refusals.push({
          code: 'trade.order_preview_invalid',
          field: 'exit',
          message: 'exit needs kind (oco or bracket_exit) and positive decimal-string takeProfit and stopLoss (stopLossLimit optional)',
        });
      } else if (discountKnown && makerFeeBps !== null && takerFeeBps !== null) {
        const legSide: 'buy' | 'sell' = kind === 'oco' ? side : side === 'buy' ? 'sell' : 'buy';
        const leg = (role: 'maker' | 'taker', bps: number, price: Amount): SpotOrderPreviewExitLegFee => {
          // Same formulas as the order's own fee: a buy pays in base, a sell in quote.
          const fee = legSide === 'buy' ? mulBps(qty, bps, 'ceil') : mulBps(mul(price, qty, 'floor'), bps, 'ceil');
          return {
            price: formatAmount(price),
            feeRole: role,
            feeBps: bps,
            estimatedFee: formatAmount(fee),
            feeAsset: legSide === 'buy' ? market.baseAsset : market.quoteAsset,
          };
        };
        exitFees = {
          side: legSide,
          takeProfit: leg('maker', makerFeeBps, takeProfit),
          stopLoss: leg('taker', takerFeeBps, legSide === 'buy' ? (stopLimit ?? stopLoss) : stopLoss),
        };
      } else {
        refusals.push({
          code: 'trade.order_preview_fee_unavailable',
          field: 'fee',
          message: 'published fee schedule is unavailable',
        });
      }
    }

    // Same trade checkAccess gate as POST /api/v1/orders. A blank list is a refusal, not a
    // clearance: the shared switch fails closed unless INTAFACED_SCREENING_FAIL_CLOSED is
    // explicitly off AND APP_ENV is dev/test. Read it from the shared config (as the other
    // trade doors and every other service do) rather than hard-coding, so a local-test stack
    // that turned it off previews the same way it places. This route posts no hold.
    const access = checkAccess({
      module: 'trade',
      plane: 'fiat',
      region: edge.region,
      kycTier: principal.tier,
      screeningFailClosed: screeningFailClosedFromEnv(),
    });
    if (!access.allowed) {
      refusals.push({ code: access.code, field: 'region', message: access.reason });
    }

    const uniqueRefusals = dedupeRefusals(refusals);
    const wire: SpotOrderPreviewWire = {
      symbol: market.symbol,
      side,
      type: typeWire,
      amount: formatAmount(qty),
      price: limitPrice === null ? null : formatAmount(limitPrice),
      stopPrice: stopTrigger === null ? null : formatAmount(stopTrigger),
      timeInForce: tif,
      holdAsset,
      holdAmount: holdAmount === null ? null : formatAmount(holdAmount),
      protectionPrice: protectionPrice === null ? null : formatAmount(protectionPrice),
      estimatedFee: estimatedFee === null ? null : formatAmount(estimatedFee),
      feeAsset,
      feeBps,
      feeRole,
      feeScheduleVersion,
      feeTier,
      makerFeeBps,
      takerFeeBps,
      makerRebateBps,
      exitFees,
      orderable: uniqueRefusals.length === 0,
      refusals: uniqueRefusals,
    };
    return reply.send(wire);
  });
}

function dedupeRefusals(refusals: SpotOrderPreviewRefusal[]): SpotOrderPreviewRefusal[] {
  const seen = new Set<string>();
  const out: SpotOrderPreviewRefusal[] = [];
  for (const row of refusals) {
    const key = `${row.code}|${row.field}|${row.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
