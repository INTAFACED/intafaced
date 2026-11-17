import { AuthError, requireScope, type Principal } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { classifyPostOutcome, formatAmount, LedgerError, parseAmount, type Amount } from '@intafaced/ledger-client';
import { mul } from '@intafaced/ledger-client/money';
import { edgeTrustFromEnv } from '@intafaced/config';
import { env } from '../env.js';
import { orderIdFor } from './ids.js';
import { readNetPositionOnMatching } from './matching-close.js';
import type { MatchingClient } from './matching-client.js';
import { classifyHoldPostError } from './hold-outcome.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
// The close is reduce-only at the engine; that door forwards the flag, so it is installed wherever the close is.
import './reduce-only-place.js';
import { TradeError, type Market, type OrderRecord, type OrderSide } from './types.js';
import type { EdgeTrust } from '../edge-trust.js';
import { POSTING_FROZEN, POSTING_FROZEN_MESSAGE, publicLedgerCode, SETTLEMENT_PENDING } from '../ledger-public-code.js';
import { privateWrite } from '../route-inventory.js';

/**
 * Close a spot position: matching owns the net, trade funds the close before the engine sees it (#4591).
 *
 *   1. Read the account's signed net on this book from matching. Flat refuses with trade.position_flat: no row, no post.
 *   2. Place a reduce-only market order for exactly that net through `placeOrder`, the one funded door: the row is
 *      written, the hold is posted (a buy at its protection price x qty, a sell in base), and only then is the order
 *      sent to the engine, as an IOC limit at the owner protection price. A refused hold sends nothing.
 *   3. The order's qty is its own, never a sum of the engine's cancellations; fills settle and the leftover hold is
 *      released through the same applySubmitResult/finalize path every order takes.
 *
 * If the position moved between the read and the engine, the engine's reduce-only check refuses a close larger than
 * the position, and that refusal releases the hold like any rejected order.
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
  readonly matching: MatchingClient;
  readonly spotEnabled: boolean;
  requireMarket: (input: { symbol?: string; marketId?: string }) => Promise<Market>;
  findOrder: (orderId: string) => Promise<OrderRecord | null>;
  slippageCap: (marketId: string) => Promise<number | null>;
  placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<OrderRecord>;
};

function asHost(svc: object): CloseHost {
  return svc as unknown as CloseHost;
}

/** Sum of ceil(price × qty) across buy fills. Not the first price times the total qty. */
export function sumBuyFillNotional(fills: readonly { readonly price: string; readonly qty: string }[]): Amount {
  return fills.reduce((n, fill) => n + mul(parseAmount(fill.price), parseAmount(fill.qty), 'ceil'), 0n) as Amount;
}

/**
 * Unit tests in close-position.flatten-hold and slice-futures-amounts still call this. A definite refusal is the one
 * set in `hold-outcome.ts`, so the two never drift. The close itself now holds before the engine (`placeOrder`).
 */
export function closeHoldFailureAction(err: unknown): 'keep_recovery' | 'delete_intent' {
  return classifyHoldPostError(err) === 'refused' ? 'delete_intent' : 'keep_recovery';
}

function closeOrderInput(marketId: string, clientOrderId: string, side: OrderSide, qty: Amount): PlaceOrderInput {
  return {
    marketId,
    side,
    type: 'market',
    qty,
    tif: 'IOC',
    clientOrderId,
    positionClose: true,
    reduceOnly: true,
  } as PlaceOrderInput;
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
  const userId = principal.userId;
  const orderId = orderIdFor(userId, market.id, input.clientOrderId);
  const existing = await host.findOrder(orderId);
  // A retry is the same command again: placeOrder returns the row, or resumes a hold whose reply was lost.
  if (existing) return host.placeOrder(principal, closeOrderInput(market.id, input.clientOrderId, existing.side, existing.qty));

  const cap = market.paper ? null : await host.slippageCap(market.id);
  if (!market.paper && (cap == null || !Number.isInteger(cap) || cap < 1 || cap > 5000)) {
    throw new TradeError(
      'flatten has no owner protection floor (TRADE_MARKET_SLIPPAGE_CAP_BPS unset) — refuse rather than send an unbounded close',
      'trade.protection_unset',
    );
  }

  const net = await readNetPositionOnMatching(host.matching, market.id, userId);
  if (net === 0n) {
    throw new TradeError('account is flat on this book; trade does not invent a mark', 'trade.position_flat');
  }
  const side: OrderSide = net > 0n ? 'sell' : 'buy';
  const qty = (net > 0n ? net : -net) as Amount;
  try {
    return await host.placeOrder(principal, closeOrderInput(market.id, input.clientOrderId, side, qty));
  } catch (err) {
    // A ledger refusal that left no row is the close's own hold, refused before the engine saw it: nothing printed,
    // nothing held. Anything else (a row kept for recovery, an unknown outcome) is passed on unchanged.
    if (err instanceof LedgerError && !(await host.findOrder(orderId))) throw new CloseNotFundedError(err);
    throw err;
  }
}

/** The close's hold was refused before the engine: the position is untouched and nothing is held. */
export class CloseNotFundedError extends Error {
  constructor(readonly ledger: LedgerError) {
    super('the close was not funded and never reached the engine');
    this.name = 'CloseNotFundedError';
    this.cause = ledger;
  }
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
  edgeTrust?: EdgeTrust;
  serviceName: string;
  closeSpotPosition: (principal: Principal, input: CloseSpotPositionInput) => Promise<OrderRecord>;
}

/** The close's hold was refused before the engine: nothing printed, nothing held. */
export const CLOSE_NOT_FUNDED = 'trade.close_not_funded';
export const CLOSE_NOT_FUNDED_MESSAGE =
  'The close could not be funded, so it was not sent: nothing was traded and nothing is held. Check the balance free for this close';
/** A close one of whose settlement posts the ledger refused by name; the printed close waits for recovery. */
export const CLOSE_SETTLEMENT_REFUSED = 'trade.close_settlement_refused';
export const CLOSE_SETTLEMENT_PENDING_MESSAGE =
  'The close reached the engine and its settlement is not confirmed: read the order before sending it again';
export const CLOSE_SETTLEMENT_REFUSED_MESSAGE =
  'The close reached the engine and the ledger refused a posting of its settlement; it is held for recovery: read the order before sending it again';
/** Any other failure: nobody knows how far the close got. */
export const CLOSE_OUTCOME_UNKNOWN_MESSAGE =
  'The close did not finish and its outcome is not known: read the order before sending it again';

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

export function attachClosePosition(app: FastifyInstance, deps: ClosePositionRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

  app.post(SPOT_CLOSE_POSITION_PATH, privateWrite, async (req, reply) => {
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
      if (error instanceof CloseNotFundedError) {
        // Refused before the engine, in fixed words: the ledger's own message (a freeze's operator reason) is never sent.
        if (publicLedgerCode(error.ledger) === POSTING_FROZEN) {
          return sendError(reply, 503, POSTING_FROZEN, POSTING_FROZEN_MESSAGE);
        }
        return sendError(reply, 400, CLOSE_NOT_FUNDED, CLOSE_NOT_FUNDED_MESSAGE);
      }
      if (error instanceof LedgerError) {
        // Any other ledger error on a close comes after the hold was posted: the row exists (it may have reached the
        // engine, or is kept for recovery), so the close exists either way. The body is typed by what the ledger
        // said, in fixed words: the ledger's own message (a freeze's operator reason, an account id) is never sent.
        //   - the posting freeze, or an outcome nobody knows (a timeout, a dropped reply, a refusal raised before the
        //     key lookup such as `ledger.unauthenticated`): its settlement is pending.
        //   - a refusal the ledger names by its engine (`classifyPostOutcome` 'refused') or a post that never left: a
        //     posting was refused; earlier posts of the same close may have booked. Held for recovery, its own code.
        const outcome = classifyPostOutcome(error);
        if (error.code === 'ledger.frozen' || outcome === 'unknown') {
          return sendError(reply, 503, SETTLEMENT_PENDING, CLOSE_SETTLEMENT_PENDING_MESSAGE);
        }
        return sendError(reply, 500, CLOSE_SETTLEMENT_REFUSED, CLOSE_SETTLEMENT_REFUSED_MESSAGE);
      }
      // Anything else (a ledger reply without a code, a transport deadline, a store error): the outcome is unknown, and
      // its message, which can carry the ledger's raw reply, is never sent.
      req.log.error({ err: error }, 'close-position failed with an untyped error');
      return sendError(reply, 503, SETTLEMENT_PENDING, CLOSE_OUTCOME_UNKNOWN_MESSAGE);
    }
  });
}

export function attachBoundClosePosition(app: FastifyInstance): void {
  if (!boundTrade) return;
  const trade = boundTrade;
  attachClosePosition(app, {
    edgeSecret: env.EDGE_PRINCIPAL_SECRET,
    edgeTrust: edgeTrustFromEnv(env),
    serviceName: env.SERVICE_NAME,
    closeSpotPosition: (principal, input) => closeSpotPosition(trade, principal, input),
  });
}

installClosePosition(TradeService);
