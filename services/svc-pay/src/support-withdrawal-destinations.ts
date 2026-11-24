/**
 * Support read of where a customer's withdrawals go (J-support-public-20 #2, RC-support-public-01): the door of the
 * record `SUPPORT_WITHDRAWAL_DESTINATIONS_READ`. svc-support asks it for the withdrawals linked to a request that holds
 * the customer's own live grant (svc-support checks the grant and lists the read to the customer).
 *
 * The answer names a destination only for a withdrawal that is this customer's. A missing id and another customer's id
 * are both left out, the same way, so the door tells nobody whether an id exists or whose it is. Only svc-support may
 * call it; any other signed service is refused. A failed read is 503, never an empty list. Nothing here moves money or
 * reads a balance.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { ServiceAuthMode, ServiceVerifier, SupportWithdrawalDestination } from '@intafaced/contracts';
import { httpRecordHandler } from '@intafaced/contracts/procedure-http';
import { retainRawBody } from '@intafaced/contracts/raw-body';
import { verifyServiceRequest } from '@intafaced/contracts/service-auth-http';
import { SUPPORT_WITHDRAWAL_DESTINATIONS_READ } from '@intafaced/contracts/support-read-grants';

const DestinationRow = z.object({ id: z.string(), destination: z.object({ kind: z.string(), ref: z.string() }) });

export async function withdrawalDestinations(
  sql: Sql,
  input: { userId: string; withdrawalIds: readonly string[] },
): Promise<SupportWithdrawalDestination[]> {
  const rows = DestinationRow.array().parse(
    await sql`
      SELECT id, destination FROM pay.withdrawals
       WHERE user_id = ${input.userId} AND id = ANY(${[...input.withdrawalIds]}::uuid[])
       ORDER BY created_at, id`,
  );
  return rows.map((row) => ({ withdrawalId: row.id, destination: { kind: row.destination.kind, ref: row.destination.ref } }));
}

export interface SupportWithdrawalDestinationsDeps {
  readonly internalSecret: string;
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly destinations: (input: { userId: string; withdrawalIds: readonly string[] }) => Promise<SupportWithdrawalDestination[]>;
}

const answer = httpRecordHandler(SUPPORT_WITHDRAWAL_DESTINATIONS_READ, async (deps: SupportWithdrawalDestinationsDeps, input) => ({
  withdrawals: await deps.destinations({ userId: input.userId, withdrawalIds: input.withdrawalIds.map((id) => id.toLowerCase()) }),
}));

export function registerSupportWithdrawalDestinationsRoute(app: FastifyInstance, deps: SupportWithdrawalDestinationsDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  const callers: readonly string[] = SUPPORT_WITHDRAWAL_DESTINATIONS_READ.access.callers;

  app.post(SUPPORT_WITHDRAWAL_DESTINATIONS_READ.path, async (req, reply) => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) return reply.code(401).send({ error: 'pay.unauthenticated', code: 'pay.unauthenticated' });
    if (!callers.includes(verified.service))
      return reply.code(403).send({ error: 'this read is for the support service only', code: 'pay.support_read_forbidden' });
    if (!SUPPORT_WITHDRAWAL_DESTINATIONS_READ.input.safeParse(req.body).success)
      return reply.code(400).send({ error: 'withdrawal destinations input is invalid', code: 'pay.support_read_input' });
    try {
      return await answer(deps, req.body);
    } catch {
      return reply.code(503).send({ error: 'withdrawal destinations unavailable', code: 'pay.support_read_unavailable' });
    }
  });
}
