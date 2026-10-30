import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FeeScheduleError } from '../spot/fee-schedule.js';
import { AuthError, requireScope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { formatAmount, mul, mulBps, parseAmount, type Amount } from '@intafaced/ledger-client';
import { checkLeverage, initialMargin, LEVERAGE_CAP_UNSET } from './initial-margin.js';
import { checkCollateralClassForMargin, UNSUPPORTED_COLLATERAL_CLASS } from './margin-mode.js';
import type { FuturesMarkProvenance } from './mark-policy.js';
import {
  correctToBand,
  FUTURES_PRICE_BAND_UNSET,
  limitWithinBand,
  marketOpenLimit,
  priceBandAround,
  splitPlan,
  SPLIT_MAX_CHILDREN,
  honouredSlippageCapBps,
} from './matched-order-plan.js';
import { LIMIT_MAX_ORDER, limitAmount, MAX_ORDER_UNSET, notionalCeil } from './pretrade-limits.js';
import type { Market } from '../spot/types.js';
import type { EdgeTrust } from '../edge-trust.js';
import { bpsToRate } from '../public-rest.js';
import { FuturesError } from './position-service.js';
import { RISK_TIER_UNAVAILABLE, type RiskTierCrossing } from './risk-tier-confirm.js';
import { OI_ROOM_UNAVAILABLE, openInterestRefusal, type OpenInterestRoom } from './open-interest-limits.js';
import type { BandInForce, BandReason } from './dynamic-price-band.js';
import { privateWrite } from '../route-inventory.js';

export interface PositionPreviewRefusal {
  code: string;
  field:
    | 'symbol'
    | 'markPrice'
    | 'leverage'
    | 'fee'
    | 'liquidationPrice'
    | 'collateral'
    | 'price'
    | 'slippage'
    | 'size'
    | 'tier'
    | 'openInterest';
  message: string;
}

export interface PositionPreviewWire {
  symbol: string;
  side: 'long' | 'short';
  size: string;
  leverage: string;
  marginMode: 'isolated';
  markPrice: string | null;
  markSource: FuturesMarkProvenance | null;
  leverageCap: string | null;
  orderValue: string | null;
  initialMargin: string | null;
  estimatedFee: string | null;
  liquidationPrice: string | null;
  /** What the ticket would send: a market open, or a limit at `limitPrice`. */
  type: 'market' | 'limit';
  /**
   * The band around the mark this order must stay inside, and why it is that wide: the owner's static band, or wider
   * while the operator's dynamic range has widened it (D-instruments-08). Null while the band is unset or there is no mark.
   */
  band: {
    fraction: string;
    low: string;
    high: string;
    staticFraction: string;
    source: 'static' | 'dynamic';
    reason: BandReason;
    /** The widest the range may go; null while the range is unset. */
    max: string | null;
    /** The futures book's premium over the mark at the last working; null when none was read. */
    premium: string | null;
    /** When the band last changed value; null before the first working. */
    changedAt: string | null;
  } | null;
  /** A market open's slippage cap in bps; null is unset, and a market open refuses. */
  slippageCapBps: number | null;
  /** The price the order would be held and sent at: the protective limit of a market open, or the limit itself. */
  orderPrice: string | null;
  /** A limit moved to the band edge under `priceCorrection: 'adjust'`: the price asked and the one applied. */
  priceCorrection: { asked: string; applied: string } | null;
  /** The owner's max-order notional (TRADE_MAX_ORDER) in the quote asset; null is unset. */
  maxOrderNotional: string | null;
  /** Above the max-order: the children `POST /api/v1/futures/orders/split` would place, largest first. */
  split: { parts: number; sizes: string[] } | null;
  /**
   * The margin tier this side sits in now and would sit in with this order (`risk-tier-confirm.ts`). When
   * `confirmRequired`, the order goes through only with `confirmTier` naming `projected`. Null while the ladder, the
   * depth or the mark is unreadable (named in `refusals`); absent where the deployment does not wire it.
   */
  riskTier?: {
    current: number | null;
    projected: number;
    maintenanceBps: number;
    maintenanceRate: string;
    notional: string;
    confirmRequired: boolean;
  } | null;
  /**
   * The market's open-interest limits and the room this account has left before this order
   * (`open-interest-limits.ts`), in the base asset. Null while a limit is blank or the room unreadable (named in
   * `refusals`); absent where the deployment does not wire it.
   */
  openInterest?: {
    limit: string;
    shareBps: number;
    accountCap: string;
    accountCommitted: string;
    marketCommitted: string;
    room: string;
    binding: 'account' | 'market';
  } | null;
  orderable: boolean;
  refusals: PositionPreviewRefusal[];
}

export interface PositionPreviewRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  marketBySymbol(symbol: string): Promise<Market | null>;
  markForMarket(marketId: string, symbol: string): Promise<{ price: string; source: FuturesMarkProvenance } | null>;
  /** Explicit owner/listing cap. Null remains a typed refusal. */
  leverageCap: Amount | null;
  /**
   * The perpetual taker rate this account's opening order would keep (`perpetualFeeRates`: the owner's schedule less
   * its rank discount). The listing row's `takerBps` is not a schedule. Null, or a schedule that is not published, is a
   * typed refusal on the fee line: the preview never shows a fee the order would not pay.
   */
  takerFeeBps: ((userId: string) => Promise<number>) | null;
  /** The owner's band as a fraction of the mark (`TRADE_FUTURES_PRICE_BAND`); null or absent is unset. */
  priceBand?: Amount | null;
  /** The band a new order on the market is held to now, as the order path reads it; absent is the static band. */
  priceBandInForce?: (marketId: string) => Promise<BandInForce>;
  /** The slippage cap a market open on this market answers to, as the order path reads it; absent is unset. */
  slippageCapBps?: (marketId: string) => Promise<number | null>;
  /** The owner's max-order in whole quote units (TRADE_MAX_ORDER), as the order path reads it; null or absent is unset. */
  maxOrder?: () => number | null;
  /**
   * Optional execution-policy calculator. Production leaves this absent until
   * a named maintenance/depth policy exists; preview must not invent one.
   */
  liquidationPriceFor?(input: {
    market: Market;
    side: 'long' | 'short';
    size: Amount;
    leverage: Amount;
    markPrice: Amount;
    initialMargin: Amount;
  }): Promise<Amount | null>;
  /**
   * The margin tier the caller's side sits in now and with this order, as the order path rates it
   * (`PositionService.riskTierCrossing`). A FuturesError (ladder unset, depth unknown) is named in the refusals.
   */
  riskTierFor?(input: {
    userId: string;
    market: Market;
    side: 'long' | 'short';
    size: Amount;
    markPrice: Amount;
  }): Promise<RiskTierCrossing>;
  /**
   * The open-interest room the caller has on this market, as the order path reads it
   * (`PositionService.openInterestRoom`). A FuturesError (a blank limit) is named in the refusals.
   */
  openInterestFor?(input: { userId: string; market: Market }): Promise<OpenInterestRoom>;
}

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

/** Read-only futures risk preview. This route never receives a ledger port. */
export function registerPositionPreviewRest(app: FastifyInstance, deps: PositionPreviewRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

  app.post('/api/v1/positions/preview', privateWrite, async (req, reply) => {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    const principal = edgeContext(edgeReq).principal;
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:read');
    } catch (error) {
      if (error instanceof AuthError) return sendError(reply, 403, 'trade.permission_denied', error.message);
      throw error;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowedFields = new Set([
      'symbol',
      'side',
      'size',
      'leverage',
      'marginMode',
      'collateralClass',
      'type',
      'limitPrice',
      'priceCorrection',
    ]);
    const suppliedServerValues = Object.keys(body).filter((key) => !allowedFields.has(key));
    if (suppliedServerValues.length > 0) {
      return sendError(
        reply,
        400,
        'trade.position_preview_server_values_only',
        `preview values are server-authored; unsupported fields: ${suppliedServerValues.sort().join(', ')}`,
      );
    }
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : '';
    const side = body.side === 'long' || body.side === 'short' ? body.side : null;
    const sizeWire = typeof body.size === 'string' ? body.size.trim() : '';
    const leverageWire = typeof body.leverage === 'string' ? body.leverage.trim() : '';
    if (body.marginMode !== undefined && body.marginMode !== 'isolated') {
      return sendError(reply, 400, 'trade.cross_margin_unavailable', 'position preview supports isolated margin only');
    }
    const size = parsePositive(sizeWire);
    const leverage = parsePositive(leverageWire);
    const type = body.type === undefined || body.type === 'market' ? 'market' : body.type === 'limit' ? 'limit' : null;
    const askedPrice = typeof body.limitPrice === 'string' ? parsePositive(body.limitPrice.trim()) : null;
    if (type === null || (type === 'limit' && askedPrice === null) || (type === 'market' && body.limitPrice !== undefined)) {
      return sendError(
        reply,
        400,
        'trade.position_preview_invalid',
        'type is market or limit; a limit needs a positive decimal-string limitPrice',
      );
    }
    if (body.priceCorrection !== undefined && body.priceCorrection !== 'reject' && body.priceCorrection !== 'adjust') {
      return sendError(reply, 400, 'trade.price_correction_invalid', 'priceCorrection is reject or adjust');
    }
    if (!symbol || !side || size === null || leverage === null) {
      return sendError(
        reply,
        400,
        'trade.position_preview_invalid',
        'symbol, side, positive decimal-string size, and positive decimal-string leverage are required',
      );
    }
    const market = await deps.marketBySymbol(symbol);
    if (!market || market.kind !== 'futures') {
      return sendError(reply, 404, 'trade.futures_market_not_found', 'futures market is not listed');
    }

    const refusals: PositionPreviewRefusal[] = [];
    // The margin is posted from cash; the order path refuses any other class on the same code.
    const classCheck = checkCollateralClassForMargin(body.collateralClass);
    if (!classCheck.ok) {
      refusals.push({
        code: classCheck.code ?? UNSUPPORTED_COLLATERAL_CLASS,
        field: 'collateral',
        message: classCheck.reason ?? 'that collateral class is not taken as margin',
      });
    }
    const cap = deps.leverageCap;
    if (cap === null) {
      refusals.push({ code: LEVERAGE_CAP_UNSET, field: 'leverage', message: 'listing leverage cap is unset' });
    } else {
      const leverageCheck = checkLeverage(leverage, cap);
      if (!leverageCheck.ok) {
        refusals.push({
          code: leverageCheck.code ?? 'trade.leverage_invalid',
          field: 'leverage',
          message: leverageCheck.reason ?? 'leverage was refused',
        });
      }
    }

    const mark = await deps.markForMarket(market.id, market.symbol);
    const markAmount = mark ? parsePositive(mark.price) : null;
    if (!mark || markAmount === null) {
      refusals.push({
        code: 'trade.position_preview_mark_unavailable',
        field: 'markPrice',
        message: 'an accepted mark is unavailable',
      });
    }

    let orderValue: Amount | null = null;
    let margin: Amount | null = null;
    let estimatedFee: Amount | null = null;
    let liquidationPrice: Amount | null = null;
    if (markAmount !== null) {
      orderValue = mul(size, markAmount, 'floor');
      try {
        margin = initialMargin({ size, entryPrice: markAmount, leverage });
      } catch {
        refusals.push({
          code: 'trade.position_preview_margin_unavailable',
          field: 'leverage',
          message: 'initial margin cannot be represented for these inputs',
        });
      }
      let takerBps: number | null = null;
      let feeMessage = 'the owner has not published a perpetual taker fee';
      if (deps.takerFeeBps) {
        try {
          takerBps = await deps.takerFeeBps(principal.userId);
        } catch (err) {
          if (!(err instanceof FeeScheduleError)) throw err;
          feeMessage = `${err.code}: ${err.message}`;
        }
      }
      if (takerBps !== null && Number.isInteger(takerBps) && takerBps >= 0) {
        estimatedFee = mulBps(orderValue, takerBps, 'ceil');
      } else {
        refusals.push({
          code: 'trade.position_preview_fee_unavailable',
          field: 'fee',
          message: feeMessage,
        });
      }
      if (margin !== null && deps.liquidationPriceFor) {
        liquidationPrice = await deps.liquidationPriceFor({ market, side, size, leverage, markPrice: markAmount, initialMargin: margin });
      }
    }
    // The price the order path would hold and send at, and the limits on it, from the same functions it uses.
    let band: PositionPreviewWire['band'] = null;
    let orderPrice: Amount | null = null;
    let priceCorrection: PositionPreviewWire['priceCorrection'] = null;
    let slippageCapBps: number | null = null;
    const bookSide = side === 'long' ? 'buy' : 'sell';
    const bandFraction = deps.priceBand ?? null;
    if (bandFraction === null) {
      refusals.push({ code: FUTURES_PRICE_BAND_UNSET, field: 'price', message: 'the owner has not published the futures price band' });
    } else if (markAmount !== null) {
      const inForce = deps.priceBandInForce ? await deps.priceBandInForce(market.id) : null;
      const fraction = inForce?.fraction ?? bandFraction;
      const at = priceBandAround(markAmount, fraction);
      band = {
        fraction: formatAmount(fraction),
        low: formatAmount(at.low),
        high: formatAmount(at.high),
        staticFraction: formatAmount(bandFraction),
        source: inForce?.source ?? 'static',
        reason: inForce?.reason ?? 'price_range_unset',
        max: inForce?.max == null ? null : formatAmount(inForce.max),
        premium: inForce?.premium == null ? null : formatAmount(inForce.premium),
        changedAt: inForce?.changedAt ? inForce.changedAt.toISOString() : null,
      };
      if (type === 'market') {
        slippageCapBps = honouredSlippageCapBps(deps.slippageCapBps ? await deps.slippageCapBps(market.id) : null);
        if (slippageCapBps === null) {
          refusals.push({
            code: 'trade.slippage_cap_unset',
            field: 'slippage',
            message: 'no slippage cap is published for this market, so a market open is refused; use a limit',
          });
        } else {
          orderPrice = marketOpenLimit(bookSide, markAmount, at, slippageCapBps);
        }
      } else {
        const asked = askedPrice!;
        const applied = body.priceCorrection === 'adjust' ? correctToBand(asked, at) : asked;
        if (applied !== asked) priceCorrection = { asked: formatAmount(asked), applied: formatAmount(applied) };
        if (limitWithinBand(applied, at)) {
          orderPrice = applied;
        } else {
          refusals.push({
            code: 'trade.futures_price_outside_band',
            field: 'price',
            message: `the limit is outside the band ${band.low} to ${band.high}; choose to move it to the edge, or change it`,
          });
        }
      }
    }

    // The owner's max-order on the order's value at the mark; above it, the split the order path would place.
    const maxOrder = deps.maxOrder ? deps.maxOrder() : null;
    let split: PositionPreviewWire['split'] = null;
    if (maxOrder === null) {
      refusals.push({ code: MAX_ORDER_UNSET, field: 'size', message: 'the owner has not published the max-order limit' });
    } else if (markAmount !== null && notionalCeil(markAmount, size) > limitAmount(maxOrder)) {
      // Compared as the order path compares it (`checkMaxOrder`: price x qty rounded up), so the boundary agrees.
      const plan = splitPlan({
        qty: size,
        // As the order path sizes children: at the band's high edge, or at the mark while the band is unset (refused above).
        sizedAt: band === null ? markAmount : parseAmount(band.high),
        maxOrderNotional: limitAmount(maxOrder),
        lotSize: market.lotSize,
      });
      if (plan.ok) split = { parts: plan.parts.length, sizes: plan.parts.map((p) => formatAmount(p)) };
      refusals.push({
        code: LIMIT_MAX_ORDER,
        field: 'size',
        message: plan.ok
          ? `the order is worth more than the max-order of ${maxOrder} ${market.quoteAsset}; it can be placed as ${plan.parts.length} orders`
          : plan.reason === 'lot_over_cap'
            ? `one lot is worth more than the max-order of ${maxOrder} ${market.quoteAsset}`
            : `the order would take ${plan.children} orders of at most ${maxOrder} ${market.quoteAsset} each, more than the ${SPLIT_MAX_CHILDREN} one request places`,
      });
    }

    let riskTier: PositionPreviewWire['riskTier'] = null;
    if (deps.riskTierFor && markAmount !== null) {
      try {
        const crossing = await deps.riskTierFor({ userId: principal.userId, market, side, size, markPrice: markAmount });
        riskTier = {
          current: crossing.currentTier,
          projected: crossing.projectedTier,
          maintenanceBps: crossing.maintenanceBps,
          maintenanceRate: bpsToRate(crossing.maintenanceBps),
          notional: formatAmount(crossing.notional),
          confirmRequired: crossing.confirmRequired,
        };
      } catch (err) {
        // The ladder's own refusals (unset, depth unknown) by their code; anything else is named, never a failed preview.
        if (err instanceof FuturesError) refusals.push({ code: err.code, field: 'tier', message: err.message });
        else refusals.push({ code: RISK_TIER_UNAVAILABLE, field: 'tier', message: 'the margin tier could not be rated' });
      }
    }

    let openInterest: PositionPreviewWire['openInterest'] = null;
    if (deps.openInterestFor) {
      try {
        const room = await deps.openInterestFor({ userId: principal.userId, market });
        openInterest = {
          limit: formatAmount(room.limit),
          shareBps: room.shareBps,
          accountCap: formatAmount(room.accountCap),
          accountCommitted: formatAmount(room.accountCommitted),
          marketCommitted: formatAmount(room.marketCommitted),
          room: formatAmount(room.room),
          binding: room.binding,
        };
        const over = openInterestRefusal(room, size, market.baseAsset);
        if (over) refusals.push({ code: over.code, field: 'openInterest', message: over.message });
      } catch (err) {
        if (err instanceof FuturesError) refusals.push({ code: err.code, field: 'openInterest', message: err.message });
        else refusals.push({ code: OI_ROOM_UNAVAILABLE, field: 'openInterest', message: 'the open-interest room could not be read' });
      }
    }

    if (liquidationPrice === null) {
      refusals.push({
        code: 'trade.position_preview_liquidation_unavailable',
        field: 'liquidationPrice',
        message: 'owner-published maintenance and depth policy is unavailable',
      });
    }

    const wire: PositionPreviewWire = {
      symbol: market.symbol,
      side,
      size: formatAmount(size),
      leverage: formatAmount(leverage),
      marginMode: 'isolated',
      markPrice: markAmount === null ? null : formatAmount(markAmount),
      markSource: markAmount === null ? null : mark!.source,
      leverageCap: cap === null ? null : formatAmount(cap),
      orderValue: orderValue === null ? null : formatAmount(orderValue),
      initialMargin: margin === null ? null : formatAmount(margin),
      estimatedFee: estimatedFee === null ? null : formatAmount(estimatedFee),
      liquidationPrice: liquidationPrice === null ? null : formatAmount(liquidationPrice),
      type,
      band,
      slippageCapBps,
      orderPrice: orderPrice === null ? null : formatAmount(orderPrice),
      priceCorrection,
      maxOrderNotional: maxOrder === null ? null : String(maxOrder),
      split,
      ...(deps.riskTierFor ? { riskTier } : {}),
      ...(deps.openInterestFor ? { openInterest } : {}),
      orderable: refusals.length === 0,
      refusals,
    };
    return reply.send(wire);
  });
}
