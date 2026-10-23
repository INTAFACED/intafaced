import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { retainRawBody, verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { LocalTestTapeError, localTestTapeRetimeSchema, retimeLocalTestTape } from './local-test-tape.js';

export const LOCAL_TEST_TAPE_RETIME_PATH = '/internal/local-test/tape-retime' as const;

/**
 * Registered by index.ts only when `localTestTapeRetimeEnabled` said yes (explicit dev/test and the flag on).
 * Body-bound service auth, always: a replayed or edited body is refused.
 */
export function registerLocalTestTapeRoutes(
  app: FastifyInstance,
  deps: {
    readonly internalSecret: string;
    /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
    readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
    readonly sql: Sql;
    readonly now?: () => Date;
    /** Isolated tests install retention. Production index already called `retainRawBody`. */
    readonly installRawBody?: boolean;
  },
): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post(LOCAL_TEST_TAPE_RETIME_PATH, async (req, reply) => {
    const auth = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (auth.service === null) return reply.code(401).send({ error: 'trade.unauthenticated' });
    const parsed = localTestTapeRetimeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'trade.local_test_tape_invalid', issues: parsed.error.issues });
    try {
      const result = await retimeLocalTestTape(deps.sql, parsed.data, deps.now?.() ?? new Date());
      req.log.warn({ ...result, caller: auth.service }, 'LOCAL TEST tape retimed');
      return reply.code(200).send({ ok: true, ...result });
    } catch (error) {
      if (error instanceof LocalTestTapeError) {
        const status = error.code === 'trade.local_test_tape_market_unknown' ? 404 : 409;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });
}
