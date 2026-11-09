/**
 * Support record ownership (J-support-public-20 #1, RC-support-public-01): svc-support asks whether a withdrawal or a
 * deposit belongs to a ticket's customer, so the desk links only the customer's own records. svc-pay answers for its
 * own tables only.
 *
 * THE ANSWER IS ONE BOOLEAN (`packages/contracts/src/support-record-ownership.ts`). A missing id, another customer's id
 * and an id of the other kind all answer `owned: false` the same way, so the door tells nobody whether an id exists or
 * whose it is. Only svc-support may call it; any other signed service is refused. A failed read is 503, never a false.
 * Nothing here moves money or reads a balance.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import {
  retainRawBody,
  SUPPORT_RECORD_OWNERSHIP_CALLERS,
  SUPPORT_RECORD_OWNERSHIP_PATH,
  supportRecordOwnershipInputSchema,
  verifyServiceRequest,
  type ServiceAuthMode,
  type ServiceVerifier,
  type SupportRecordOwnershipInput,
} from '@intafaced/contracts';

export async function recordOwned(sql: Sql, input: SupportRecordOwnershipInput): Promise<boolean> {
  const rows =
    input.kind === 'withdrawal'
      ? await sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pay.withdrawals WHERE id = ${input.recordId} AND user_id = ${input.userId}`
      : await sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pay.deposits WHERE id = ${input.recordId} AND user_id = ${input.userId}`;
  return (rows[0]?.n ?? 0) > 0;
}

export interface SupportRecordOwnershipDeps {
  readonly internalSecret: string;
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly owned: (input: SupportRecordOwnershipInput) => Promise<boolean>;
}

export function registerSupportRecordOwnershipRoute(app: FastifyInstance, deps: SupportRecordOwnershipDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post(SUPPORT_RECORD_OWNERSHIP_PATH, async (req, reply) => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) return reply.code(401).send({ error: 'pay.unauthenticated', code: 'pay.unauthenticated' });
    if (!(SUPPORT_RECORD_OWNERSHIP_CALLERS as readonly string[]).includes(verified.service)) {
      return reply.code(403).send({ error: 'record ownership is for the support service only', code: 'pay.record_ownership_forbidden' });
    }
    const parsed = supportRecordOwnershipInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'record ownership input is invalid', code: 'pay.record_ownership_input' });
    try {
      return { owned: await deps.owned(parsed.data) };
    } catch {
      return reply.code(503).send({ error: 'record ownership unavailable', code: 'pay.record_ownership_unavailable' });
    }
  });
}
