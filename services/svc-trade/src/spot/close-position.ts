import { AuthError, requireScope, type Principal } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { formatAmount, parseAmount, recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { mul } from '@intafaced/ledger-client/money';
import type { Sql } from 'postgres';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import { env } from '../env.js';
import { orderIdFor } from './ids.js';
import { isDefiniteLedgerRefusal, ledgerOutcomeUnknown } from './hold-outcome.js';
import { closePositionOnMatching, type MatchingCloseRequest } from './matching-close.js';
import type { EngineSubmitResult, MatchingClient } from './matching-client.js';
import { assertMarketOpen, assertSettlementRails, assertTradable, holdFor } from './risk.js';
import { TradeService } from './trade-service.js';
import { attributionFromPrincipal, withLedgerAttribution } from './auth-attribution.js';
import { TradeError, type Market, type OrderRecord, type OrderSide } from './types.js';

/**
 * Close a spot position through the matching flatten that landed in #3249.
 *
 * Matching owns net fills. Trade does not invent a mark or a qty.
 * Flat refuses with trade.position_flat — no row, no ledger post.
 * An accepted flatten funds from the engine result, then leftover hold
 * is released through recipes.orderHoldRelease via applySubmitResult/finalize.
 *
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 */

export const SPOT_CLOSE_POSITION_PATH = '/api/v1/spot/positions/close';

export type CloseSpotPositionInput = {
  marketId?: string;
  symbol?: string;
  clientOrderId: string;
};

const FLAG = Symbol.for('intafaced.trade.closeSpotPosition');

let boundTrade: TradeService | null = null;

export function bindCloseSpotTrade(svc: TradeService): void {
  boundTrade = svc;
}

type CloseHost = {
  readonly sql: Sql;
  readonly ledger: LedgerClient;
  readonly matching: MatchingClient;
  readonly spotEnabled: boolean;
  readonly futuresEnabled: boolean;
  readonly optionsSettlementAssetLaw: string;
  now: () => Date;
  perks: { perksOf(userId: string): Promise<{ feeDiscountBps: number }> };
  requireMarket: (input: { symbol?: string; marketId?: string }) => Promise<Market>;
  findOrder: (orderId: string) => Promise<OrderRecord | null>;
  assertLifecycleAction: (market: Market, action: 'PLACE') => Promise<LifecycleAdmissionProof>;
  applySubmitResult: (market: Market, orderId: string, result: EngineSubmitResult) => Promise<void>;
  markRecoveryRequired: (orderId: string, reason: 'SUBMIT_UNKNOWN') => Promise<void>;
};

function asHost(svc: object): CloseHost {
  return svc as unknown as CloseHost;
}

function flattenFromResult(result: EngineSubmitResult): { side: OrderSide; qty: Amount; price: Amount } {
  const fillQty = result.fills.reduce((n, f) => n + parseAmount(f.qty), 0n);
  const cancelQty = result.cancellations.reduce((n, c) => n + parseAmount(c.remainingQty), 0n);
  const qty = fillQty + cancelQty;
  const side = (result.fills[0]?.takerSide ?? result.resting?.side) as OrderSide | undefined;
  if (!side || qty <= 0n) {
    throw new TradeError('matching flatten printed no side or qty; trade does not invent a mark', 'trade.invalid_qty');
  }
  const price = result.fills[0] ? parseAmount(result.fills[0].price) : result.resting ? parseAmount(result.resting.price) : 0n;
  return { side, qty, price };
}

export async function closeSpotPosition(svc: TradeService, principal: Principal, input: CloseSpotPositionInput): Promise<OrderRecord> {
  requireScope(principal, 'trade:write');
  const host = asHost(svc);
  if (!host.spotEnabled) {
    throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
  }
  if (input.clientOrderId == null || input.clientOrderId.length < 1 || input.clientOrderId.length > 64) {
    throw new TradeError('clientOrderId is required (1–64 chars) so a retry cannot open a second hold', 'trade.client_order_id_required');
  }

  const market = await host.requireMarket(input);
  assertTradable(market, {
    futuresEnabled: host.futuresEnabled,
    optionsSettlementLawStamped: host.optionsSettlementAssetLaw.trim().length > 0,
    now: host.now(),
  });
  assertSettlementRails(market);
  assertMarketOpen(market, host.now());

  const userId = principal.userId;
  const attribution = attributionFromPrincipal(principal);
  const orderId = orderIdFor(userId, market.id, input.clientOrderId);
  const existing = await host.findOrder(orderId);
  if (existing) return existing;

  const lifecycleProof = await host.assertLifecycleAction(market, 'PLACE');
  const request: MatchingCloseRequest = {
    orderId,
    accountId: userId,
    lifecycleProof,
  };

  const result = await closePositionOnMatching(host.matching, market.id, request);

  if (!result.accepted && result.rejected?.code === 'position_flat') {
    throw new TradeError('account is flat on this book; trade does not invent a mark', 'trade.position_flat');
  }
  if (!result.accepted) {
    throw new TradeError(result.rejected?.message ?? 'matching refused the flatten', 'trade.invalid_qty');
  }

  const flatten = flattenFromResult(result);
  // A BUY flatten can sweep several levels: hold the exact executed notional, not first price x qty (#4591).
  const buyNotional = result.fills.reduce((n, f) => n + mul(parseAmount(f.price), parseAmount(f.qty), 'ceil'), 0n) as Amount;
  const hold =
    flatten.side === 'buy' ? { assetId: market.quoteAsset, amount: buyNotional } : holdFor(market, flatten.side, 0n as Amount, flatten.qty);
  const perks = await host.perks.perksOf(userId);

  // A market row carries no price (orders_price_shape_ck); the executed prices live in trade.fills (#4591).
  const inserted = await host.sql<Array<{ id: string }>>`
    INSERT INTO trade.orders (
      id, user_id, market_id, client_order_id, side, type,
      price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps, seeded, lifecycle_proof,
      session_id, api_key_id
    ) VALUES (
      ${orderId}, ${userId}, ${market.id}, ${input.clientOrderId},
      ${flatten.side}, ${'market'},
      ${null}::numeric,
      ${formatAmount(flatten.qty)}::numeric, 'pending', ${'IOC'},
      ${hold.assetId}, ${formatAmount(market.paper ? 0n : hold.amount)}::numeric, ${perks.feeDiscountBps},
      ${false}, ${JSON.stringify(lifecycleProof)}::text::jsonb,
      ${attribution.sessionId}, ${attribution.apiKeyId}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;

  if (inserted.length === 0) {
    const raced = await host.findOrder(orderId);
    if (raced) return raced;
    throw new TradeError(`order ${orderId} vanished between insert and read`, 'trade.order_not_found');
  }

  if (!market.paper && hold.amount > 0n) {
    try {
      await host.ledger.post(
        withLedgerAttribution(recipes.orderHold({ orderId, userId, assetId: hold.assetId, amount: hold.amount }), attribution),
      );
    } catch (err) {
      // Delete the intent row only on a typed refusal made before anything committed. Any other ending (timeout,
      // deadline, network, 5xx, malformed acknowledgement) can follow a booked hold, and the engine has ALREADY executed
      // this flatten, so the row is kept and marked `recovery_required`: it is never auto-deleted by reconcile, a retry
      // returns it as it stands, and an operator sees the order instead of a silent pending row.
      if (!isDefiniteLedgerRefusal(err)) {
        await host.markRecoveryRequired(orderId, 'SUBMIT_UNKNOWN');
        throw ledgerOutcomeUnknown(orderId, err);
      }
      await host.sql`DELETE FROM trade.orders WHERE id = ${orderId} AND status = 'pending'`;
      throw err;
    }
  }

  await host.sql`UPDATE trade.orders SET status = 'open', updated_at = now() WHERE id = ${orderId} AND status = 'pending'`;

  try {
    await host.applySubmitResult(market, orderId, result);
  } catch (err) {
    await host.markRecoveryRequired(orderId, 'SUBMIT_UNKNOWN');
    throw err;
  }

  const settled = await host.findOrder(orderId);
  if (!settled) throw new TradeError(`order ${orderId} vanished during settlement`, 'trade.order_not_found');
  return settled;
}

export function installClosePosition(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    closeSpotPosition?: (principal: Principal, input: CloseSpotPositionInput) => Promise<OrderRecord>;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;
  proto.closeSpotPosition = function (this: TradeService, principal: Principal, input: CloseSpotPositionInput) {
    return closeSpotPosition(this, principal, input);
  };
}

export interface ClosePositionRestDeps {
  edgeSecret: string;
  serviceName: string;
  closeSpotPosition: (principal: Principal, input: CloseSpotPositionInput) => Promise<OrderRecord>;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

export function attachClosePosition(app: FastifyInstance, deps: ClosePositionRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, serviceName: deps.serviceName });

  app.post(SPOT_CLOSE_POSITION_PATH, async (req, reply) => {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    const principal = edgeContext(edgeReq).principal;
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:write');
    } catch (error) {
      if (error instanceof AuthError) return sendError(reply, 403, 'trade.permission_denied', error.message);
      throw error;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.price !== undefined || body.qty !== undefined || body.amount !== undefined || body.mark !== undefined) {
      return sendError(reply, 400, 'trade.invalid_qty', 'close does not take a mark, qty, or price; matching owns the net');
    }
    const clientOrderId = typeof body.clientOrderId === 'string' ? body.clientOrderId : '';
    const marketId = typeof body.marketId === 'string' ? body.marketId : undefined;
    const symbol = typeof body.symbol === 'string' ? body.symbol : undefined;
    if (!clientOrderId || (!marketId && !symbol)) {
      return sendError(reply, 400, 'trade.bad_request', 'clientOrderId and marketId|symbol are required');
    }

    try {
      const order = await deps.closeSpotPosition(principal, { clientOrderId, marketId, symbol });
      return reply.code(200).send({
        id: order.id,
        marketId: order.marketId,
        clientOrderId: order.clientOrderId,
        side: order.side,
        type: order.type,
        qty: formatAmount(order.qty),
        filledQty: formatAmount(order.filledQty),
        status: order.status,
        rejectCode: order.rejectCode,
      });
    } catch (error) {
      if (error instanceof TradeError) {
        const status = error.code === 'trade.position_flat' ? 409 : error.code === 'trade.market_not_found' ? 404 : 400;
        return sendError(reply, status, error.code, error.message);
      }
      throw error;
    }
  });
}

export function attachBoundClosePosition(app: FastifyInstance): void {
  if (!boundTrade) return;
  const trade = boundTrade;
  attachClosePosition(app, {
    edgeSecret: env.EDGE_PRINCIPAL_SECRET,
    serviceName: env.SERVICE_NAME,
    closeSpotPosition: (principal, input) => closeSpotPosition(trade, principal, input),
  });
}

installClosePosition(TradeService);
