/**
 * S2S read of a business team for svc-agents' team roles and approvals (J-agents-11). Only svc-agents may call; the
 * body is bound to the signature. The answer comes from bank.business_accounts and bank.business_members only, and
 * only to a member of the business. A failed read is 503 `bank.team_membership_unavailable`, never an empty team.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AGENTS_TEAM_MEMBERSHIP_PATH,
  agentsTeamMembershipRequestSchema,
  agentsTeamMembershipResponseSchema,
  verifyServiceRequest,
  type AgentsTeamBusinessRole,
  type AgentsTeamMembershipResponse,
  type ServiceAuthMode,
  type ServiceVerifier,
} from '@intafaced/contracts';
import type { Sql } from 'postgres';

/** A business holds at most this many members in one answer; more is refused, never a cut-off team. */
export const TEAM_MEMBERSHIP_MAX = 200;

export class TeamMembershipIncomplete extends Error {
  readonly code = 'bank.team_membership_incomplete' as const;
  constructor() {
    super(`business team has more than ${TEAM_MEMBERSHIP_MAX} members`);
  }
}

/** The business team as the asking person may see it. Ids are compared in lower case, as svc-bank stores them. */
export async function teamMembershipFor(sql: Sql, rawUserId: string, rawBusinessId: string): Promise<AgentsTeamMembershipResponse> {
  const userId = rawUserId.toLowerCase();
  const businessId = rawBusinessId.toLowerCase();
  const rows = await sql<Array<{ status: string; user_id: string; role: AgentsTeamBusinessRole; asker: boolean }>>`
    SELECT a.status, m.user_id, m.role::text AS role, (m.user_id = ${userId}) AS asker
      FROM bank.business_accounts a
      JOIN bank.business_members m ON m.account_id = a.id
     WHERE a.id = ${businessId}
       AND EXISTS (SELECT 1 FROM bank.business_members me WHERE me.account_id = a.id AND me.user_id = ${userId})
     ORDER BY m.created_at, m.user_id
     LIMIT ${TEAM_MEMBERSHIP_MAX + 1}
  `;
  if (rows.length > TEAM_MEMBERSHIP_MAX) throw new TeamMembershipIncomplete();
  const me = rows.find((row) => row.asker);
  if (!me) return { ok: false, reason: 'not_member' };
  if (me.status !== 'active') return { ok: false, reason: 'business_closed' };
  return { ok: true, businessId, role: me.role, members: rows.map((row) => ({ userId: row.user_id, role: row.role })) };
}

function callerOf(req: FastifyRequest, secret: string, s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode }): string | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  try {
    return verifyServiceRequest(req, { verifier: s2s?.verifier, mode: s2s?.mode, legacySecret: secret, bodyBindMode: 'require' }).service;
  } catch {
    return null;
  }
}

export function registerAgentsTeamMembership(
  app: FastifyInstance,
  deps: {
    secret: string;
    s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode };
    read: (userId: string, businessId: string) => Promise<AgentsTeamMembershipResponse>;
  },
): void {
  app.post(AGENTS_TEAM_MEMBERSHIP_PATH, async (req, reply) => {
    const caller = callerOf(req, deps.secret, deps.s2s);
    if (caller === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
    }
    if (caller !== 'svc-agents') {
      return reply.code(403).send({ error: 'business team read is for the agents service only', code: 'bank.team_membership_forbidden' });
    }
    const parsed = agentsTeamMembershipRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'team membership request is invalid', code: 'bank.team_membership_input' });
    }
    try {
      const checked = agentsTeamMembershipResponseSchema.safeParse(await deps.read(parsed.data.userId, parsed.data.businessId));
      if (checked.success) return checked.data;
    } catch (err) {
      if (err instanceof TeamMembershipIncomplete) {
        return reply.code(503).send({ error: 'business team is too large to answer whole', code: err.code });
      }
      // Falls through: a failed read is never an empty team and never the database's own words.
    }
    return reply.code(503).send({ error: 'business team could not be read', code: 'bank.team_membership_unavailable' });
  });
}
