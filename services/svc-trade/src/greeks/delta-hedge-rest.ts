/**
 * CARD R-E6 — auto delta-hedge HTTP door.
 *
 * No ledger port. Unset owner sockets refuse by name. Decimal strings when
 * previewing. Does not list a live option.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, requireScope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { checkAutoDeltaHedge, DELTA_HEDGE_PATH } from './delta-hedge.js';
import type { EdgeTrust } from '../edge-trust.js';
import { privateWrite } from '../route-inventory.js';

export { DELTA_HEDGE_PATH };

export interface DeltaHedgeRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  /** Owner sockets from boot env. Blank refuses. */
  target?: string;
  range?: string;
  instrument?: string;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ ok: false, error: code, message, executed: false, orders: [] });
}

/** Preview-only auto delta-hedge. This route never receives a ledger port. */
export function registerDeltaHedgeRest(app: FastifyInstance, deps: DeltaHedgeRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

  app.post(DELTA_HEDGE_PATH, privateWrite, async (req, reply) => {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    const principal = edgeContext(edgeReq).principal;
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:read');
    } catch (error) {
      if (error instanceof AuthError) return sendError(reply, 403, 'trade.permission_denied', error.message);
      throw error;
    }

    const result = checkAutoDeltaHedge({
      target: deps.target,
      range: deps.range,
      instrument: deps.instrument,
    });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        error: result.code,
        message: result.reason,
        executed: false,
        orders: [],
      });
    }
    return reply.code(200).send(result);
  });
}
