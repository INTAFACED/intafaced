import { AuthError, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import type { RouteCost } from '@intafaced/contracts/api-rate-limits';
import type { FastifyInstance } from 'fastify';
import type { KeyBuckets } from './rate-bucket.js';

/** The published cost table. Public: it names no key and no account. */
export const RATE_COSTS_PATH = '/api/edge/rate-limits/costs' as const;
/** One key's usage, for its owner in a signed-in session. */
export const KEY_USAGE_PATH = '/api/edge/rate-limits/keys/:keyId/usage' as const;

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RateLimitsDoorDeps {
  readonly tokens: TokenConfig;
  /** Refuses a key, a sub-account, or a session identity no longer holds (`token.invalid`). */
  readonly sessionLive: (principal: Principal) => Promise<void>;
  readonly buckets: KeyBuckets;
  readonly costs: readonly RouteCost[];
  /** The per-address limit this edge enforces (`EDGE_RATE_LIMIT_MAX` per `EDGE_RATE_LIMIT_WINDOW_MS`), or null when off. */
  readonly address: { readonly max: number; readonly windowMs: number } | null;
  readonly now?: () => number;
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1] ?? null;
}

/**
 * The edge's own rate-limit doors (DV-limits-01 and 02, J-developer-06 #1 #3). The cost table is the owner's value as
 * this edge enforces it (an empty list while none is set). The usage read is the caller's own key on this replica: it
 * is never counted against the key, and a key that is not the caller's reads exactly like a key with no calls yet.
 */
export function registerRateLimitsDoor(app: FastifyInstance, deps: RateLimitsDoorDeps): void {
  const clock = deps.now ?? Date.now;

  app.get(RATE_COSTS_PATH, async (_req, reply) =>
    reply
      .code(200)
      .header('cache-control', 'no-store')
      .send({ asOf: new Date(clock()).toISOString(), costs: deps.costs, address: deps.address }),
  );

  app.get<{ Params: { keyId: string } }>(KEY_USAGE_PATH, async (req, reply) => {
    let principal: Principal;
    try {
      const token = bearer(req.headers.authorization);
      if (!token) throw new AuthError('Sign in to read a key’s usage', 'token.invalid');
      principal = await verifyAccessToken(token, deps.tokens);
      // A key or a sub-account never reads usage: only the person, signed in on a device.
      await deps.sessionLive(principal);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(401).header('cache-control', 'no-store').send({ error: err.message, code: err.code });
      }
      throw err;
    }
    const keyId = req.params.keyId.toLowerCase();
    if (!KEY_ID.test(keyId)) {
      return reply.code(400).header('cache-control', 'no-store').send({ error: 'A key id is a UUID', code: 'edge.request_invalid' });
    }
    return reply
      .code(200)
      .header('cache-control', 'no-store')
      .send(deps.buckets.usage(keyId, principal.userId, clock()));
  });
}
