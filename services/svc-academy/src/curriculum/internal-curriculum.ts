/**
 * GET /internal/curriculum — service-to-service spine for the AI Coach.
 *
 * Same control as identity `/internal/rank`: service credentials, no user
 * principal. A call signed with svc-agents' own key is accepted beside the shared
 * secret (`dual`), or alone (`keypair`); only svc-agents may call this door. tRPC `curriculum` is academy:read and would require a caller
 * identity svc-agents does not hold.
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
import { coachSpinePayload } from './coach-spine.js';

/** The only service that reads the curriculum spine. An authenticated service not named here is refused. */
const CURRICULUM_CALLERS: readonly string[] = ['svc-agents'];

export function registerInternalCurriculumRoute(
  app: FastifyInstance,
  internalSecret: string,
  bodyBind: ServiceBodyBindMode = DEFAULT_SERVICE_BODY_BIND_MODE,
  s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode },
): void {
  retainRawBody(app);

  app.get('/internal/curriculum', async (req, reply) => {
    const caller = verifyServiceRequest(req, {
      verifier: s2s?.verifier,
      mode: s2s?.mode,
      legacySecret: internalSecret,
      bodyBindMode: bodyBind,
    }).service;
    if (caller === null || !CURRICULUM_CALLERS.includes(caller)) {
      return reply.code(401).send({ error: 'service credentials required', code: 'academy.unauthenticated' });
    }
    return coachSpinePayload();
  });
}
