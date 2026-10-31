import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, requireScope, type Principal } from '@intafaced/auth';
import { checkAccess } from '@intafaced/config';
import {
  createEdgeContext,
  retainRawBody,
  verifyServiceRequest,
  type ServiceAuthMode,
  type ServiceVerifier,
  type EdgeRequest,
} from '@intafaced/contracts';
import { outcomeMarketMoveInputSchema } from '@intafaced/contracts/outcome-markets';
import { createOrderRequestSchema } from '@intafaced/exchange-contract';
import { parseAmount } from '@intafaced/ledger-client';
import { collateralForBinaryBuy, type OutcomeMarket, type OutcomeSide } from './outcomes/outcome-market.js';
import { presentCcxtOrder } from './private-rest.js';
import type { OrderRecord, TimeInForce } from './spot/types.js';
import type { EdgeTrust } from './edge-trust.js';
import { internalRoute, privateWrite, publicRead } from './route-inventory.js';

/** Why no market can be published yet: the owner's determination decision (E-1) is open. */
export const OUTCOME_PUBLISH_BLOCKER = 'owner.decision' as const;

export interface OutcomeCatalogue {
  list(): readonly OutcomeMarket[];
  byId(marketId: string): OutcomeMarket | null;
  byInstrument(symbol: string): OutcomeMarket | null;
}

export function memoryOutcomeCatalogue(markets: readonly OutcomeMarket[]): OutcomeCatalogue {
  const byId = new Map(markets.map((market) => [market.id, market]));
  const byInstrument = new Map<string, OutcomeMarket>();
  for (const market of markets) {
    for (const instrument of market.instruments) byInstrument.set(instrument.symbol, market);
  }
  return {
    list: () => [...markets],
    byId: (marketId) => byId.get(marketId) ?? null,
    byInstrument: (symbol) => byInstrument.get(symbol) ?? null,
  };
}

export interface PlaceOutcomeOrderInput {
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  qty: bigint;
  price: bigint | null;
  tif?: TimeInForce;
  clientOrderId: string;
  /** Full one-settlement-unit-per-contract hold, never price × size. */
  collateralAssetId: string;
  collateralAmount: string;
}

export interface OutcomesRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  /**
   * Isolated tests install retention. Production index already called
   * `retainRawBody` on the same Fastify instance.
   */
  installRawBody?: boolean;
  catalogue: OutcomeCatalogue;
  /** Must post its hold through ledger-client and its order through matching. */
  placeOutcomeOrder?(principal: Principal, input: PlaceOutcomeOrderInput): Promise<OrderRecord>;
  /** Must settle through ledger-client recipes; unset refuses. */
  settleMarket?(market: OutcomeMarket, result: OutcomeSide, settlementId: string): Promise<void>;
  now?: () => number;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

/** Public listing + authenticated order + S2S settlement doors. */
export function registerOutcomesRest(app: FastifyInstance, deps: OutcomesRestDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });
  const now = deps.now ?? Date.now;

  function contextFrom(req: FastifyRequest) {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    return edgeContext(edgeReq);
  }

  app.get('/api/v1/outcomes/markets', publicRead, async (_req, reply) => reply.send(deps.catalogue.list()));

  app.post('/api/v1/outcomes/orders', privateWrite, async (req, reply) => {
    const { principal, region } = contextFrom(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    // Same gate as every other trade write: a region or tier that may not trade may not place an outcome order.
    const access = checkAccess({ module: 'trade', plane: 'fiat', region, kycTier: principal.tier });
    if (!access.allowed) return sendError(reply, 403, access.code ?? 'trade.permission_denied', access.reason);
    try {
      requireScope(principal, 'trade:write');
    } catch (error) {
      if (error instanceof AuthError) return sendError(reply, 403, 'trade.permission_denied', error.message);
      throw error;
    }

    const parsed = createOrderRequestSchema.safeParse(req.body);
    if (!parsed.success)
      return sendError(reply, 400, 'trade.outcome_order_invalid', 'order fields must match the decimal-string order schema');
    if (
      parsed.data.requestDeadline !== undefined ||
      parsed.data.stpMode !== undefined ||
      parsed.data.tag !== undefined ||
      parsed.data.triggerBy !== undefined
    ) {
      return sendError(
        reply,
        400,
        'trade.outcome_order_invalid',
        'outcome orders take no request deadline, self-trade mode, tag or trigger source',
      );
    }
    const market = deps.catalogue.byInstrument(parsed.data.symbol);
    if (!market) return sendError(reply, 404, 'trade.outcome_market_not_found', 'outcome instrument is not listed');
    if (Date.parse(market.closeAt) <= now()) return sendError(reply, 409, 'trade.outcome_market_closed', 'outcome market is closed');
    if (!parsed.data.clientOrderId?.trim()) {
      return sendError(reply, 400, 'trade.outcome_client_order_id_required', 'clientOrderId is required for retry safety');
    }
    if (!deps.placeOutcomeOrder) {
      return sendError(reply, 503, 'trade.outcome_order_path_unconfigured', 'ledger-backed outcome order path is not configured');
    }

    // Outcome contracts settle at 0 or 1, so a limit price must lie strictly inside (0, 1); market orders have no price.
    const priceRaw = parsed.data.price;
    if (priceRaw == null || parsed.data.type !== 'limit') {
      return sendError(reply, 400, 'trade.outcome_order_invalid', 'outcome orders must be limit orders with a price between 0 and 1');
    }
    const priceUnits = parseAmount(priceRaw);
    if (priceUnits <= 0n || priceUnits >= parseAmount('1')) {
      return sendError(reply, 400, 'trade.outcome_order_invalid', 'outcome limit price must be strictly between 0 and 1');
    }
    if (parsed.data.stopPrice != null || parsed.data.expireAt != null) {
      return sendError(reply, 400, 'trade.outcome_order_invalid', 'outcome orders do not support stopPrice or expireAt');
    }

    const collateralAmount = collateralForBinaryBuy(parsed.data.amount);
    const order = await deps.placeOutcomeOrder(principal, {
      symbol: parsed.data.symbol,
      side: parsed.data.side,
      type: parsed.data.type,
      qty: parseAmount(parsed.data.amount),
      price: parsed.data.price == null ? null : parseAmount(parsed.data.price),
      ...(parsed.data.timeInForce ? { tif: parsed.data.timeInForce } : {}),
      clientOrderId: parsed.data.clientOrderId.trim(),
      collateralAssetId: market.settlementAssetId,
      collateralAmount,
    });
    return reply.send(presentCcxtOrder(order, parsed.data.symbol));
  });

  /** A service-signed request bound to its body, or a 401 sent and false. */
  function fromService(req: FastifyRequest, reply: FastifyReply): boolean {
    const service = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    }).service;
    if (service === null) sendError(reply, 401, 'trade.unauthenticated', 'service credentials required');
    return service !== null;
  }

  // Publishing a market waits for the owner's decision on who determines a result, from which sources, the challenge window
  // and the dispute path (ENGINE E-1, PM-2). Until then the door is there and refuses, typed; it publishes nothing.
  app.post('/api/v1/outcomes/markets/publish', internalRoute, async (req, reply) => {
    if (!fromService(req, reply)) return reply;
    const body = req.body;
    const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    const parsed = record ? outcomeMarketMoveInputSchema.safeParse({ move: 'published', ...record }) : null;
    if (!parsed?.success || parsed.data.move !== 'published') {
      return sendError(reply, 400, 'trade.outcome_move_invalid', 'a publish request is { marketId, expectedOrdinal } and nothing else');
    }
    return sendError(
      reply,
      412,
      OUTCOME_PUBLISH_BLOCKER,
      'Publishing a prediction market waits for an owner decision on who determines a result. Nothing was published.',
    );
  });

  app.post('/api/v1/outcomes/settle', internalRoute, async (req, reply) => {
    if (!fromService(req, reply)) return reply;
    const body = req.body as Record<string, unknown> | null;
    const marketId = typeof body?.marketId === 'string' ? body.marketId.trim() : '';
    const settlementSource = typeof body?.settlementSource === 'string' ? body.settlementSource.trim() : '';
    const settlementId = typeof body?.settlementId === 'string' ? body.settlementId.trim() : '';
    const result = body?.result;
    const market = deps.catalogue.byId(marketId);
    if (!market) return sendError(reply, 404, 'trade.outcome_market_not_found', 'outcome market is not listed');
    if (!settlementSource || settlementSource !== market.settlementSource) {
      return sendError(reply, 400, 'trade.outcome_settlement_source_mismatch', 'result source does not match the listing');
    }
    if (result !== 'yes' && result !== 'no') {
      return sendError(reply, 400, 'trade.outcome_result_invalid', 'result must be yes or no');
    }
    if (!settlementId) {
      return sendError(reply, 400, 'trade.outcome_settlement_id_required', 'settlementId is required for retry safety');
    }
    if (!deps.settleMarket) {
      return sendError(reply, 503, 'trade.outcome_settlement_path_unconfigured', 'ledger-backed settlement path is not configured');
    }
    await deps.settleMarket(market, result, settlementId);
    return reply.send({ ok: true, marketId: market.id, result, settlementId });
  });
}
