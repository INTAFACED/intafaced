import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { retainRawBody, verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { answerTestAgeDoor, type TestAgeSubject } from '@intafaced/service-kit';

export const TEST_AGE_PATH = '/internal/test/age' as const;

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/**
 * An OTC desk quote not yet settled, made `ms` earlier: its creation, expiry and acceptance all move back together, so
 * its quote expiry or settle window has passed as if the time had gone by. A settled quote is history and is not aged.
 */
export function ageOtcQuote(sql: Sql): TestAgeSubject {
  return async (id, ms) => {
    const rows = await sql<{ created_at: Date; expires_at: Date; accepted_at: Date | null }[]>`
      UPDATE otc_desk_quotes
      SET created_at = created_at - make_interval(secs => ${ms / 1000}),
          expires_at = expires_at - make_interval(secs => ${ms / 1000}),
          accepted_at = accepted_at - make_interval(secs => ${ms / 1000})
      WHERE quote_id = ${id} AND lifecycle <> 'settled'
      RETURNING created_at, expires_at, accepted_at
    `;
    const row = rows[0];
    if (!row) return null;
    return { createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), acceptedAt: iso(row.accepted_at) };
  };
}

/**
 * The TEST age door (packages/service-kit test-age.ts), always mounted: closed, it answers `test_age.door_closed`.
 * Body-bound service auth, always: a replayed or edited body is refused.
 */
export function registerTestAgeDoor(
  app: FastifyInstance,
  deps: {
    readonly open: boolean;
    readonly internalSecret: string;
    /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
    readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
    readonly subjects: Readonly<Record<string, TestAgeSubject>>;
    /** Isolated tests install retention. Production index already called `retainRawBody`. */
    readonly installRawBody?: boolean;
  },
): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  app.post(TEST_AGE_PATH, async (req, reply) => {
    const auth = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (auth.service === null) return reply.code(401).send({ error: 'trade.unauthenticated' });
    const answer = await answerTestAgeDoor(deps.open, deps.subjects, req.body);
    if (answer.status === 200) req.log.warn({ ...answer.body, caller: auth.service }, 'TEST record aged');
    return reply.code(answer.status).send(answer.body);
  });
}
