/**
 * GET /internal/curriculum — service-to-service spine for the AI Coach.
 *
 * Same control as identity `/internal/rank`: service credentials, no user
 * principal. A call signed with svc-agents' own key is accepted beside the shared
 * secret (`dual`), or alone (`keypair`); only the record's callers (svc-agents) may call this door. tRPC `curriculum` is
 * academy:read and would require a caller identity svc-agents does not hold. The path, the callers, the refusal and the
 * reply's shape are the record's (`ACADEMY_INTERNAL_CURRICULUM`).
 *
 * Bytes are retained so a v2 digest can be checked against the empty GET body.
 */

import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_SERVICE_BODY_BIND_MODE,
  retainRawBody,
  verifyServiceRequest,
  type ServiceAuthMode,
  type ServiceBodyBindMode,
  type ServiceVerifier,
} from '@intafaced/contracts';
import { ACADEMY_INTERNAL_CURRICULUM } from '@intafaced/contracts/academy-procedures';
import { coachSpinePayload } from './coach-spine.js';

/** The services that read the curriculum spine, as the record names them. An authenticated service not named is refused. */
const CURRICULUM_CALLERS: readonly string[] = ACADEMY_INTERNAL_CURRICULUM.access.callers;

export function registerInternalCurriculumRoute(
  app: FastifyInstance,
  internalSecret: string,
  bodyBind: ServiceBodyBindMode = DEFAULT_SERVICE_BODY_BIND_MODE,
  s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode },
): void {
  retainRawBody(app);

  app.get(ACADEMY_INTERNAL_CURRICULUM.path, async (req, reply) => {
    const caller = verifyServiceRequest(req, {
      verifier: s2s?.verifier,
      mode: s2s?.mode,
      legacySecret: internalSecret,
      bodyBindMode: bodyBind,
    }).service;
    if (caller === null || !CURRICULUM_CALLERS.includes(caller)) {
      return reply.code(401).send({ error: 'service credentials required', code: 'academy.unauthenticated' });
    }
    return ACADEMY_INTERNAL_CURRICULUM.output.parse(coachSpinePayload());
  });
}
