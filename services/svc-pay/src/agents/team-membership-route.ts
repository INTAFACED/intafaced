/**
 * S2S read of the asking person's business team, for svc-agents' team roles, pool and project limits
 * (AG-governance-01). Only svc-agents may call; the body is bound to the signature. A person on no business gets
 * `{ ok: false, reason: 'no_business' }`, which svc-agents turns into its own typed refusal.
 */

import type { FastifyInstance } from 'fastify';
import {
  AGENTS_TEAM_MEMBERSHIP_PATH,
  agentsTeamMembershipRequestSchema,
  retainRawBody,
  verifyServiceRequest,
  type AgentsTeamMembershipResponse,
  type ServiceAuthMode,
  type ServiceVerifier,
} from '@intafaced/contracts';

export interface AgentsTeamMembershipRouteDeps {
  readonly internalSecret: string;
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly read: (userId: string) => Promise<AgentsTeamMembershipResponse>;
}

export function registerAgentsTeamMembershipRoute(app: FastifyInstance, deps: AgentsTeamMembershipRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post(AGENTS_TEAM_MEMBERSHIP_PATH, async (req, reply) => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) {
      return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
    }
    if (verified.service !== 'svc-agents') {
      return reply
        .code(403)
        .send({ error: 'pay.team_membership_service_forbidden', message: 'only svc-agents may read business team membership' });
    }
    const parsed = agentsTeamMembershipRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'pay.team_membership_invalid', message: 'userId must be a uuid' });
    }
    return reply.send(await deps.read(parsed.data.userId));
  });
}
