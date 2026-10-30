/**
 * CARD R-promo — create-promo HTTP door.
 *
 * No ledger port. Missing budget/end refuse by name. Never invent rebate bps.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, requireScope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { checkCreatePromo, CREATE_PROMO_PATH } from './promo.js';
import type { EdgeTrust } from '../edge-trust.js';
import { privateWrite } from '../route-inventory.js';

export { CREATE_PROMO_PATH };

export interface PromoRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  /** Owner sockets from boot env. Blank refuses. */
  budget?: string;
  end?: string;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({
    ok: false,
    error: code,
    message,
    created: false,
    posted: false,
    rebateBps: null,
  });
}

/** Preview-only create-promo. This route never receives a ledger port. */
export function registerPromoRest(app: FastifyInstance, deps: PromoRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

  app.post(CREATE_PROMO_PATH, privateWrite, async (req, reply) => {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    const principal = edgeContext(edgeReq).principal;
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:write');
    } catch (error) {
      if (error instanceof AuthError) return sendError(reply, 403, 'trade.permission_denied', error.message);
      throw error;
    }

    const body = (req.body ?? {}) as { budget?: unknown; end?: unknown; rebateBps?: unknown };
    const result = checkCreatePromo({
      budget: present(body.budget) ? body.budget : deps.budget,
      end: present(body.end) ? body.end : deps.end,
      rebateBps: body.rebateBps,
    });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        error: result.code,
        message: result.reason,
        created: false,
        posted: false,
        rebateBps: null,
      });
    }
    return reply.code(200).send(result);
  });
}

function present(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  return true;
}
