/**
 * S2S read for svc-support (J-support-public-20 #1, RC-support-public-01): does this withdrawal or deposit belong to the
 * ticket's customer? Answers `{ owned: boolean }` and nothing else (`packages/contracts/src/support-record-ownership.ts`).
 *
 * Only svc-support may call it, and the body is bound to the signature. A missing id, another customer's id and an id of
 * the other kind all answer `owned: false` through the same single-row lookup by primary key and owner, so neither the
 * answer nor its error code says whether an id exists or whose it is. Read only: no amount, status or destination leaves
 * svc-pay, and nothing is written.
 */

import type { FastifyInstance } from 'fastify';
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
import type { Sql } from 'postgres';

export type RecordOwnershipRead = (input: SupportRecordOwnershipInput) => Promise<boolean>;

export interface RecordOwnershipRouteDeps {
  readonly internalSecret: string;
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly owns: RecordOwnershipRead;
}

/**
 * One EXISTS per kind, by primary key and owner: the same index probe whether the id is missing or someone else's. A
 * deposit is either a rail deposit (`pay.deposits`) or an on-chain custody deposit (`pay.custody_deposits`).
 */
export function recordOwnershipReader(sql: Sql): RecordOwnershipRead {
  return async ({ kind, recordId, userId }) => {
    const rows =
      kind === 'withdrawal'
        ? await sql<{ owned: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM pay.withdrawals WHERE id = ${recordId}::uuid AND user_id = ${userId}) AS owned`
        : await sql<{ owned: boolean }[]>`
            SELECT (
              EXISTS (SELECT 1 FROM pay.deposits WHERE id = ${recordId}::uuid AND user_id = ${userId})
              OR EXISTS (SELECT 1 FROM pay.custody_deposits WHERE id = ${recordId}::uuid AND user_id = ${userId})
            ) AS owned`;
    return rows[0]?.owned === true;
  };
}

export function registerRecordOwnershipRoute(app: FastifyInstance, deps: RecordOwnershipRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post(SUPPORT_RECORD_OWNERSHIP_PATH, async (req, reply) => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) {
      return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
    }
    if (!SUPPORT_RECORD_OWNERSHIP_CALLERS.includes(verified.service as (typeof SUPPORT_RECORD_OWNERSHIP_CALLERS)[number])) {
      return reply
        .code(403)
        .send({ error: 'pay.record_ownership_service_forbidden', message: 'only svc-support may ask who owns a record' });
    }
    const input = supportRecordOwnershipInputSchema.safeParse(req.body);
    if (!input.success) {
      return reply.code(400).send({ error: 'pay.record_ownership_invalid', message: 'kind, recordId (uuid) and userId are required' });
    }
    return reply.send({ owned: await deps.owns(input.data) });
  });
}
