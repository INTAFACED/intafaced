import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, requireScope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { formatAmount, mul, mulBps, parseAmount, type Amount } from '@intafaced/ledger-client';
import { checkLeverage, initialMargin, LEVERAGE_CAP_UNSET } from './initial-margin.js';
import type { FuturesMarkProvenance } from './mark-policy.js';
import type { Market } from '../spot/types.js';
import type { EdgeTrust } from '../edge-trust.js';

export interface PositionPreviewRefusal {
  code: string;
  field: 'symbol' | 'markPrice' | 'leverage' | 'fee' | 'liquidationPrice';
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
    const allowedFields = new Set(['symbol', 'side', 'size', 'leverage', 'marginMode']);
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
      if (Number.isInteger(market.takerBps) && market.takerBps >= 0) {
        estimatedFee = mulBps(orderValue, market.takerBps, 'ceil');
      } else {
        refusals.push({
          code: 'trade.position_preview_fee_unavailable',
          field: 'fee',
          message: 'published taker fee is unavailable',
        });
      }
      if (margin !== null && deps.liquidationPriceFor) {
        liquidationPrice = await deps.liquidationPriceFor({ market, side, size, leverage, markPrice: markAmount, initialMargin: margin });
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
      orderable: refusals.length === 0,
      refusals,
    };
    return reply.send(wire);
  });
}
