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

export interface PositionPreviewRefusal {
  code: string;
  field: 'symbol' | 'markPrice' | 'leverage' | 'fee' | 'liquidationPrice' | 'collateral' | 'price' | 'slippage' | 'size';
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
  /** The owner's band around the mark this order must stay inside; null while the band is unset or there is no mark. */
  band: { fraction: string; low: string; high: string } | null;
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

  app.post('/api/v1/positions/preview', async (req, reply) => {
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
      const at = priceBandAround(markAmount, bandFraction);
      band = { fraction: formatAmount(bandFraction), low: formatAmount(at.low), high: formatAmount(at.high) };
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
      orderable: refusals.length === 0,
      refusals,
    };
    return reply.send(wire);
  });
}
