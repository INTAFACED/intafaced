/**
 * CARD R-quant — live deploy HTTP door.
 *
 * No ledger port. Unpinned owner pin refuses by name. Paper cannot ledger.
 * Pin present still does not launch. Does not list a live option.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, requireScope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { checkQuantLiveDeploy, QUANT_LIVE_DEPLOY_PATH } from './live-deploy.js';
import type { EdgeTrust } from '../edge-trust.js';
import { privateWrite } from '../route-inventory.js';

export { QUANT_LIVE_DEPLOY_PATH };

export interface QuantLiveDeployRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  /** Owner eligibility pin from boot env. Blank refuses. */
  pin?: string;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({
    ok: false,
    error: code,
    message,
    executed: false,
    launched: false,
    posted: false,
    orders: [],
  });
}

/** Preview-only live deploy. This route never receives a ledger port. */
export function registerQuantLiveDeployRest(app: FastifyInstance, deps: QuantLiveDeployRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

  app.post(QUANT_LIVE_DEPLOY_PATH, privateWrite, async (req, reply) => {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    const principal = edgeContext(edgeReq).principal;
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:write');
    } catch (error) {
      if (error instanceof AuthError) return sendError(reply, 403, 'trade.permission_denied', error.message);
      throw error;
    }

    const body = (req.body ?? {}) as { environment?: unknown };
    const result = checkQuantLiveDeploy({
      environment: body.environment,
      pin: deps.pin,
    });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        error: result.code,
        message: result.reason,
        executed: false,
        launched: false,
        posted: false,
        orders: [],
      });
    }
    return reply.code(200).send(result);
  });
}
