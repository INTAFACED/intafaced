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
} from './risk.js';
import { previewFeeBps, type OwnerFeeSchedule } from './fee-schedule.js';
import { TradeError, type Market, type OrderSide, type OrderType, type TimeInForce } from './types.js';

export const SPOT_ORDER_PREVIEW_PATH = '/api/v1/orders/preview';

export interface SpotOrderPreviewRefusal {
  code: string;
  field: 'symbol' | 'type' | 'side' | 'amount' | 'price' | 'holdAmount' | 'fee' | 'protectionPrice' | 'region';
  message: string;
}

export interface SpotOrderPreviewWire {
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  amount: string;
  price: string | null;
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
  orderable: boolean;
  refusals: SpotOrderPreviewRefusal[];
}

export interface SpotOrderPreviewRestDeps {
  edgeSecret: string;
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
  spotEnabled: boolean;
  futuresEnabled: boolean;
  optionsSettlementLawStamped: boolean;
  /** Null/unset → market-buy preview refuses `trade.slippage_cap_unset`. */
  slippageCapBps: number | null;
  /** PTX-M21 owner fee/rebate schedule. Unpublished → typed refuse, never invent bps. */
  feeSchedule: OwnerFeeSchedule;
}

const ALLOWED_FIELDS = new Set([
  'symbol',
  'side',
  'type',
  'amount',
  'price',
  'stopPrice',
  'timeInForce',
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
    refusals.push({ code: error.code, field, message: error.message });
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
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, serviceName: deps.serviceName });

  app.post(SPOT_ORDER_PREVIEW_PATH, async (req, reply) => {
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
    const priceWire = body.price === undefined ? null : typeof body.price === 'string' ? body.price.trim() : '';
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
      body.timeInForce === 'IOC' || body.timeInForce === 'FOK' || body.timeInForce === 'PO' || body.timeInForce === 'GTC'
        ? body.timeInForce
        : 'GTC';
    if (body.postOnly === true) {
      if (tif !== 'GTC' && tif !== 'PO') {
        return sendError(reply, 400, 'trade.invalid_price', 'postOnly cannot be combined with an immediate time-in-force');
      }
      tif = 'PO';
    }

    const refusals: SpotOrderPreviewRefusal[] = [];
    let orderType: OrderType | null = null;
    try {
      orderType = requireSupportedType(typeWire);
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
    }

    try {
      assertQty(market, qty);
    } catch (error) {
      pushError(refusals, error, 'amount');
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

    let protectionPrice: Amount | null = null;
    let fundingPrice: Amount | null = limitPrice;
    if (orderType === 'market' && side === 'buy') {
      const ask = deps.bestAsk ? await deps.bestAsk(market.id) : null;
      try {
        protectionPrice = protectionPriceFor(market, ask ?? null, deps.slippageCapBps);
        assertNotional(market, protectionPrice, qty);
        fundingPrice = protectionPrice;
      } catch (error) {
        pushError(refusals, error, 'protectionPrice');
      }
    } else if (orderType === 'market' && side === 'sell') {
      fundingPrice = 0n;
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

    const feeRole: 'maker' | 'taker' | null = orderType === null ? null : tif === 'PO' ? 'maker' : 'taker';
    const feeBps = feeRole === null ? null : previewFeeBps(deps.feeSchedule, feeRole);
    let estimatedFee: Amount | null = null;
    let feeAsset: string | null = null;
    if (feeRole === null) {
      // type already refused
    } else if (feeBps === null) {
      refusals.push({
        code: 'trade.order_preview_fee_unavailable',
        field: 'fee',
        message: 'published fee schedule is unavailable',
      });
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
      timeInForce: tif,
      holdAsset,
      holdAmount: holdAmount === null ? null : formatAmount(holdAmount),
      protectionPrice: protectionPrice === null ? null : formatAmount(protectionPrice),
      estimatedFee: estimatedFee === null ? null : formatAmount(estimatedFee),
      feeAsset,
      feeBps,
      feeRole,
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
