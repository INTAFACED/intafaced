import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, requireScope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { FeeScheduleError } from '../spot/fee-schedule.js';
import type { Market } from '../spot/types.js';
import type { EdgeTrust } from '../edge-trust.js';
import { checkLeverage, LEVERAGE_CAP_UNSET, LEVERAGE_STEP } from './initial-margin.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import { bpsToRate } from '../public-rest.js';
import { calculate, MARGIN_FORMULAS, riskTiers, type DepthBySide } from './risk-calculator.js';
import { privateWrite, publicRead } from '../route-inventory.js';

export const LADDER_UNSET = 'trade.ladder_unset';

export interface RiskCalculatorRefusal {
  code: string;
  field: 'leverage' | 'fee' | 'liquidationPrice' | 'maintenanceMargin';
  message: string;
}

export interface RiskCalculatorRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  marketBySymbol(symbol: string): Promise<Market | null>;
  /** The liquidation tick's own ladder. Undefined is unset: the tier read refuses and the calculator names it. */
  publishedLadder(): FuturesLadderPolicy | undefined;
  /** The tick's own depth read: quote depth on the side a position closes into. Null or a throw is unreadable. */
  depthNotional(input: { marketId: string; side: 'long' | 'short'; symbol: string }): Promise<Amount | null>;
  leverageCap: Amount | null;
  /** The account's perpetual taker rate, the same one the preview and the order read; a FeeScheduleError is unpublished. */
  takerFeeBps: ((userId: string) => Promise<number>) | null;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

function parsePositive(value: unknown): Amount | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = parseAmount(value.trim());
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

const fmt = (value: Amount | null): string | null => (value === null ? null : formatAmount(value));

async function readDepth(deps: RiskCalculatorRestDeps, market: Market, side: 'long' | 'short'): Promise<Amount | null> {
  try {
    const depth = await deps.depthNotional({ marketId: market.id, side, symbol: market.symbol });
    return depth != null && depth > 0n ? depth : null;
  } catch {
    return null;
  }
}

async function futuresMarket(deps: RiskCalculatorRestDeps, reply: FastifyReply, symbolWire: unknown): Promise<Market | null> {
  const symbol = typeof symbolWire === 'string' ? symbolWire.trim() : '';
  if (!symbol) {
    sendError(reply, 400, 'trade.futures_symbol_required', 'symbol is required');
    return null;
  }
  const market = await deps.marketBySymbol(symbol);
  if (!market || market.kind !== 'futures') {
    sendError(reply, 404, 'trade.futures_market_not_found', 'futures market is not listed');
    return null;
  }
  return market;
}

/**
 * The tier table (`GET /api/v1/futures/tiers`) and the margin and P&L calculator (`POST /api/v1/futures/calculator`).
 * Read-only: neither route receives a ledger port, and neither stores a row.
 */
export function registerRiskCalculatorRest(app: FastifyInstance, deps: RiskCalculatorRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

  // Public, like the ticker: the table is the owner's published policy and today's depth.
  app.get<{ Querystring: { symbol?: string } }>('/api/v1/futures/tiers', publicRead, async (req, reply) => {
    const market = await futuresMarket(deps, reply, req.query.symbol);
    if (!market) return reply;
    const policy = deps.publishedLadder();
    if (!policy) {
      // A 4xx, not a 5xx: this is the owner's answer (no tiers yet), not a service that failed to give one.
      return sendError(
        reply,
        409,
        LADDER_UNSET,
        'the owner has not published the maintenance tiers; opening a position is refused until they do',
      );
    }
    const [long, short] = await Promise.all([readDepth(deps, market, 'long'), readDepth(deps, market, 'short')]);
    const depth: DepthBySide = { long, short };
    return reply.send({
      symbol: market.symbol,
      tiers: riskTiers(policy, depth).map((t) => ({
        tier: t.tier,
        uptoDepthBps: t.uptoDepthBps,
        maintenanceBps: t.maintenanceBps,
        maintenanceRate: bpsToRate(t.maintenanceBps),
        notionalUpto: { long: fmt(t.notionalUpto.long), short: fmt(t.notionalUpto.short) },
      })),
      depth: { long: fmt(depth.long), short: fmt(depth.short) },
      // The ladder publishes no leverage of its own, so every tier answers to the listing cap; blank is never unlimited.
      maxLeverage: fmt(deps.leverageCap),
      leverageBasis: deps.leverageCap === null ? LEVERAGE_CAP_UNSET : 'listing_cap',
      formula: MARGIN_FORMULAS.tier,
    });
  });

  app.post('/api/v1/futures/calculator', privateWrite, async (req, reply) => {
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
    const allowed = new Set(['symbol', 'side', 'size', 'entryPrice', 'exitPrice', 'leverage', 'marginMode']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      return sendError(reply, 400, 'trade.calculator_invalid', `unsupported fields: ${unknown.sort().join(', ')}`);
    }
    if (body.marginMode !== undefined && body.marginMode !== 'isolated') {
      return sendError(reply, 400, 'trade.margin_variant_unsupported', 'the calculator covers isolated margin only');
    }
    const side = body.side === 'long' || body.side === 'short' ? body.side : null;
    const size = parsePositive(body.size);
    const entryPrice = parsePositive(body.entryPrice);
    const leverage = parsePositive(body.leverage);
    const exitPrice = body.exitPrice === undefined || body.exitPrice === '' ? null : parsePositive(body.exitPrice);
    if (
      !side ||
      size === null ||
      entryPrice === null ||
      leverage === null ||
      (body.exitPrice !== undefined && body.exitPrice !== '' && exitPrice === null)
    ) {
      return sendError(
        reply,
        400,
        'trade.calculator_invalid',
        'side, and positive decimal-string size, entryPrice and leverage are required; exitPrice is optional',
      );
    }
    const market = await futuresMarket(deps, reply, body.symbol);
    if (!market) return reply;
    if (market.futuresFamily === 'inverse') {
      return sendError(reply, 400, 'trade.margin_variant_unsupported', 'inverse contracts are not covered by the calculator');
    }

    const refusals: RiskCalculatorRefusal[] = [];
    if (leverage % LEVERAGE_STEP !== 0n) {
      // The order path refuses this leverage, so the figures for it would be for a trade that cannot be placed.
      refusals.push({ code: 'trade.leverage_invalid', field: 'leverage', message: 'leverage has at most two decimal places' });
    } else if (deps.leverageCap === null) {
      refusals.push({ code: LEVERAGE_CAP_UNSET, field: 'leverage', message: 'the listing leverage cap is unset' });
    } else {
      const check = checkLeverage(leverage, deps.leverageCap);
      if (!check.ok)
        refusals.push({ code: check.code ?? 'trade.leverage_invalid', field: 'leverage', message: check.reason ?? 'leverage was refused' });
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
    if (takerBps === null || !Number.isInteger(takerBps) || takerBps < 0) {
      takerBps = null;
      refusals.push({ code: 'trade.position_preview_fee_unavailable', field: 'fee', message: feeMessage });
    }

    // Inputs are positive past the parse, so margin cannot round to zero (it rounds up): anything thrown below is the
    // service's fault and answers 500, never "check your numbers".
    const policy = deps.publishedLadder() ?? null;
    const depthNotional = policy ? await readDepth(deps, market, side) : null;
    const result = calculate({ side, size, entryPrice, leverage, exitPrice, takerBps, policy, depthNotional });
    if (result.liquidationReason === 'ladder_unset') {
      refusals.push({ code: LADDER_UNSET, field: 'maintenanceMargin', message: 'the owner has not published the maintenance tiers' });
    } else if (result.liquidationReason === 'depth_unknown') {
      refusals.push({
        code: 'trade.depth_unknown',
        field: 'maintenanceMargin',
        message: 'the book depth this tier is rated against is unreadable',
      });
    } else if (result.liquidationReason !== null) {
      refusals.push({
        code: `trade.liquidation_price_${result.liquidationReason}`,
        field: 'liquidationPrice',
        message:
          result.liquidationReason === 'between_tiers'
            ? 'the ladder acts where the requirement steps between two tiers, so no single price is shown'
            : 'this position has no liquidation price above zero',
      });
    }

    return reply.send({
      symbol: market.symbol,
      side,
      marginMode: 'isolated',
      size: formatAmount(size),
      entryPrice: formatAmount(entryPrice),
      exitPrice: fmt(exitPrice),
      leverage: formatAmount(leverage),
      leverageCap: fmt(deps.leverageCap),
      notional: formatAmount(result.notional),
      initialMargin: formatAmount(result.initialMargin),
      tier: result.tier,
      maintenanceBps: result.maintenanceBps,
      maintenanceMargin: fmt(result.maintenanceMargin),
      liquidationPrice: fmt(result.liquidationPrice),
      pnl: fmt(result.pnl),
      roePercent: fmt(result.roePercent),
      takerFeeBps: takerBps,
      entryFee: fmt(result.entryFee),
      exitFee: fmt(result.exitFee),
      netPnl: fmt(result.netPnl),
      // The price basis of each figure: what was typed, and the ladder at today's depth.
      basis: { prices: 'typed', maintenance: 'ladder_at_current_depth' },
      formulas: MARGIN_FORMULAS,
      refusals,
    });
  });
}
