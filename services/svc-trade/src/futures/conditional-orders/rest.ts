/**
 * Caller doors for futures conditional orders and the resting-order refusal.
 *
 * List, get, and cancel read only the signed account. A missing scope is
 * refused before the service is called. Resting futures orders refuse
 * `trade.futures_resting_unsupported` and the service inserts nothing.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, requireScope, type Principal } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { FuturesError } from '../position-service.js';
import type { ConditionalOrderService } from './service.js';
import { FUTURES_RESTING_UNSUPPORTED } from './resting.js';
import type { EdgeTrust } from '../../edge-trust.js';
import { privateRead, privateWrite } from '../../route-inventory.js';

export const CONDITIONAL_ORDERS_PATH = '/api/v1/futures/conditional-orders';
export const PROTECTION_PATH = '/api/v1/positions/:id/protection';
export const RESTING_ORDERS_PATH = '/api/v1/futures/orders';
export const ENTRY_PROTECTION_PATH = '/api/v1/futures/entry-protection';

export interface ConditionalOrdersRestDeps {
  readonly edgeSecret: string;
  readonly edgeTrust?: EdgeTrust;
  readonly serviceName: string;
  readonly orders: Pick<
    ConditionalOrderService,
    'create' | 'list' | 'get' | 'cancel' | 'replaceProtection' | 'placeResting' | 'listEntryProtection'
  >;
  /**
   * Mount the resting-order refusal at RESTING_ORDERS_PATH. Default true. False while futures orders go through the
   * matching book, whose own routes then answer that path.
   */
  readonly restingRefusal?: boolean;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

export function registerConditionalOrdersRest(app: FastifyInstance, deps: ConditionalOrdersRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

  function principalOf(req: { headers: Record<string, string | string[] | undefined>; id: string }): Principal | null {
    const edgeReq: EdgeRequest = { headers: req.headers, id: req.id };
    return edgeContext(edgeReq).principal;
  }

  function fail(err: unknown, reply: FastifyReply): FastifyReply {
    if (err instanceof FuturesError) return sendError(reply, err.status, err.code, err.message);
    if (err instanceof AuthError) return sendError(reply, 403, 'trade.permission_denied', err.message);
    throw err;
  }

  app.post(CONDITIONAL_ORDERS_PATH, privateWrite, async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const created = await deps.orders.create(principal.userId, {
        market: body.market,
        kind: body.kind,
        side: body.side,
        quantity: body.quantity,
        triggerPrice: body.triggerPrice,
        limitPrice: body.limitPrice,
        trailingDistance: body.trailingDistance,
        reduceOnly: body.reduceOnly,
        clientOrderId: body.clientOrderId,
        triggerSource: body.triggerSource,
      });
      return reply.code(created.replay ? 200 : 201).send(created.order);
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.get(CONDITIONAL_ORDERS_PATH, privateRead, async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send({ orders: await deps.orders.list(principal.userId) });
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>(`${CONDITIONAL_ORDERS_PATH}/:id`, privateRead, async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send(await deps.orders.get(principal.userId, req.params.id));
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>(`${CONDITIONAL_ORDERS_PATH}/:id`, privateWrite, async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:write');
      return reply.code(200).send(await deps.orders.cancel(principal.userId, req.params.id));
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.put<{ Params: { id: string } }>(PROTECTION_PATH, privateWrite, async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const replaced = await deps.orders.replaceProtection(principal.userId, req.params.id, {
        takeProfit: body.takeProfit,
        stopLoss: body.stopLoss,
        clientRequestId: body.clientRequestId,
      });
      return reply.code(200).send(replaced);
    } catch (err) {
      return fail(err, reply);
    }
  });

  // What each opening order asked to be protected with, and how far its legs have armed.
  app.get(ENTRY_PROTECTION_PATH, privateRead, async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send({ protections: await deps.orders.listEntryProtection(principal.userId) });
    } catch (err) {
      return fail(err, reply);
    }
  });

  async function refuseResting(
    req: { headers: Record<string, string | string[] | undefined>; id: string },
    reply: FastifyReply,
    write: boolean,
  ) {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, write ? 'trade:write' : 'trade:read');
      if (write) {
        const body = (req as { body?: unknown }).body as { clientOrderId?: unknown } | undefined;
        const key = body?.clientOrderId;
        if (typeof key !== 'string' || key.trim().length < 1 || key.trim().length > 64) {
          return sendError(reply, 400, 'trade.client_order_id_required', 'clientOrderId is required (1–64 chars)');
        }
      }
      await deps.orders.placeResting();
      return reply;
    } catch (err) {
      return fail(err, reply);
    }
  }

  if (deps.restingRefusal === false) return;
  app.post(RESTING_ORDERS_PATH, privateWrite, async (req, reply) => refuseResting(req, reply, true));
  app.get(RESTING_ORDERS_PATH, privateRead, async (req, reply) => refuseResting(req, reply, false));
  app.delete<{ Params: { id: string } }>(`${RESTING_ORDERS_PATH}/:id`, privateWrite, async (req, reply) => refuseResting(req, reply, true));
}

export { FUTURES_RESTING_UNSUPPORTED };
