/**
 * Caller doors for the trader's margin and liquidation-risk alerts (D-account-03, `./risk-alerts.ts`;
 * J-derivatives-06 #6).
 *
 * GET reads the levels, the toggle's state (`levels_unset` is "set your risk levels") and the recent crossings;
 * PUT `{ enabled, levels, clientRequestId }` sets them (`levels` percents as decimal strings). Turning the alert on with
 * no levels refuses `trade.risk_alert_levels_unset` (409). The liquidation alert (the margin call) is always on and has
 * no door to turn it off. Both read and write only the signed account.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, requireScope, type Principal } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { FuturesError } from './position-service.js';
import type { RiskAlertService } from './risk-alerts.js';
import type { EdgeTrust } from '../edge-trust.js';
import { privateRead, privateWrite } from '../route-inventory.js';

export const RISK_ALERTS_PATH = '/api/v1/futures/risk-alerts';

export interface RiskAlertsRestDeps {
  readonly edgeSecret: string;
  readonly edgeTrust?: EdgeTrust;
  readonly serviceName: string;
  readonly alerts: Pick<RiskAlertService, 'get' | 'set'>;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

export function registerRiskAlertsRest(app: FastifyInstance, deps: RiskAlertsRestDeps): void {
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

  app.get(RISK_ALERTS_PATH, privateRead, async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send(await deps.alerts.get(principal.userId));
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.put(RISK_ALERTS_PATH, privateWrite, async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      return reply
        .code(200)
        .send(
          await deps.alerts.set(principal.userId, { enabled: body.enabled, levels: body.levels, clientRequestId: body.clientRequestId }),
        );
    } catch (err) {
      return fail(err, reply);
    }
  });
}
