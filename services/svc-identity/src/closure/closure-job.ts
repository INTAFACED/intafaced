/**
 * HMAC job door. Finalises closures whose cooling-off has ended.
 * Blank limit refuses. This route does not erase history.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';
import { AccountClosureService, ClosureError, publishedFinalizeLimit } from './closure-service.js';

function authorized(req: FastifyRequest, secret: string, s2s?: IdentityS2s): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  try {
    return serviceOfRequest(req, secret, 'require', s2s).service !== null;
  } catch {
    return false;
  }
}

function bodyLimit(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  if (!('limit' in body)) return undefined;
  return (body as { limit?: unknown }).limit;
}

export function registerClosureFinalize(
  app: FastifyInstance,
  deps: { secret: string; s2s?: IdentityS2s; closure: AccountClosureService },
): void {
  app.post('/internal/jobs/finalize-account-closures', async (req, reply) => {
    if (!authorized(req, deps.secret, deps.s2s)) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    const limit = publishedFinalizeLimit(bodyLimit(req.body));
    if (limit === null) {
      return reply.code(400).send({
        error: 'finalize limit is unset',
        code: 'identity.close_finalize_limit_unset',
      });
    }
    try {
      return await deps.closure.finalize(limit);
    } catch (err) {
      if (err instanceof ClosureError && err.code === 'identity.close_finalize_limit_unset') {
        return reply.code(400).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });
}
