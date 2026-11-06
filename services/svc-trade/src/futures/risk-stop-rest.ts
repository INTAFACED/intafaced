/**
 * Caller doors for a position's pre-liquidation stop (D-margin-04, `./risk-stop.ts`).
 *
 * GET reads the stop with the position's margin ratio now and the mark the stop closes at; PUT `{ level, clientRequestId }`
 * sets it (`level` a percent as a decimal string, null clears it). Both read only the signed account; another user's
 * position is the same 404 as a missing one.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, requireScope, type Principal } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { FuturesError } from './position-service.js';
import type { RiskStopService } from './risk-stop.js';
import type { EdgeTrust } from '../edge-trust.js';
import { privateRead, privateWrite } from '../route-inventory.js';

export const RISK_STOP_PATH = '/api/v1/positions/:id/risk-stop';

export interface RiskStopRestDeps {
  readonly edgeSecret: string;
  readonly edgeTrust?: EdgeTrust;
  readonly serviceName: string;
  readonly stops: Pick<RiskStopService, 'get' | 'set'>;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

export function registerRiskStopRest(app: FastifyInstance, deps: RiskStopRestDeps): void {
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

  app.get<{ Params: { id: string } }>(RISK_STOP_PATH, privateRead, async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send(await deps.stops.get(principal.userId, req.params.id));
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.put<{ Params: { id: string } }>(RISK_STOP_PATH, privateWrite, async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!('level' in body)) return sendError(reply, 400, 'trade.risk_stop_invalid', 'level is required: a percent, or null to clear');
      return reply
        .code(200)
        .send(await deps.stops.set(principal.userId, req.params.id, { level: body.level, clientRequestId: body.clientRequestId }));
    } catch (err) {
      return fail(err, reply);
    }
  });
}
