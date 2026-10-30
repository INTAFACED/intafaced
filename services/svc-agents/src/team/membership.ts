/**
 * A business's team, read from svc-bank over S2S (`POST /internal/agents/team-membership`). The person names the
 * business; svc-bank answers its members only when the person is one of them. svc-agents never stores who is a
 * member: every team call reads it again, so a removed member is gone at the next call. A failed read refuses
 * `agents.membership_unavailable`; it is never an empty team.
 */

import {
  AGENTS_TEAM_MEMBERSHIP_PATH,
  agentsTeamMembershipResponseSchema,
  serviceCallSigner,
  type AgentsTeamMembershipResponse,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { TeamError } from './errors.js';

export interface TeamMembershipPort {
  read(userId: string, businessId: string): Promise<AgentsTeamMembershipResponse>;
}

export type HttpTeamMembershipOptions = {
  readonly bankUrl: string;
  readonly internalSecret: string;
  readonly s2s?: { readonly signer: ServiceSigner; readonly mode: ServiceAuthMode };
  readonly fetchImpl?: typeof fetch;
};

function unavailable(): TeamError {
  return new TeamError('Business team could not be read from svc-bank', 'agents.membership_unavailable');
}

export function createHttpTeamMembershipPort(options: HttpTeamMembershipOptions): TeamMembershipPort {
  const target = new URL(`${options.bankUrl.replace(/\/$/, '')}${AGENTS_TEAM_MEMBERSHIP_PATH}`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sign = serviceCallSigner({
    service: 'svc-agents',
    audience: 'svc-bank',
    legacySecret: options.internalSecret,
    s2s: options.s2s,
  });
  return {
    async read(userId, businessId) {
      const body = JSON.stringify({ userId, businessId });
      let response: Response;
      try {
        response = await fetchImpl(target, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...sign(body, { method: 'POST', url: target, contentType: 'application/json' }),
          },
          body,
        });
      } catch {
        throw unavailable();
      }
      if (!response.ok) throw unavailable();
      const parsed = agentsTeamMembershipResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw unavailable();
      // svc-bank's answer must be about the business asked for; any other is not this team.
      if (parsed.data.ok && parsed.data.businessId !== businessId.toLowerCase()) throw unavailable();
      return parsed.data;
    },
  };
}
