/**
 * CARD H7 — what-if/greeks HTTP door.
 *
 * No ledger port. Unlinked native refuses numbers. Decimal strings when linked.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, requireScope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import type { GreeksAdapter, VanillaEuropeanInput } from '@intafaced/greeks-adapter';
import { GREEKS_WHAT_IF_PATH, whatIfVanillaGreeks } from './what-if.js';
import type { EdgeTrust } from '../edge-trust.js';
import { privateWrite } from '../route-inventory.js';

export { GREEKS_WHAT_IF_PATH };

export interface GreeksWhatIfRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  /** Injected in tests. Production uses createGreeksAdapter() (env-linked). */
  adapter?: GreeksAdapter;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

/** Read-only QuantLib what-if. This route never receives a ledger port. */
export function registerGreeksWhatIfRest(app: FastifyInstance, deps: GreeksWhatIfRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

  app.post(GREEKS_WHAT_IF_PATH, privateWrite, async (req, reply) => {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    const principal = edgeContext(edgeReq).principal;
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:read');
    } catch (error) {
      if (error instanceof AuthError) return sendError(reply, 403, 'trade.permission_denied', error.message);
      throw error;
    }

    const body = (req.body ?? {}) as Partial<VanillaEuropeanInput>;
    const result = whatIfVanillaGreeks(body, { adapter: deps.adapter });
    return reply.code(200).send(result);
  });
}
