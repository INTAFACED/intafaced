import type { Sql } from 'postgres';
import type { AgentsTeamMembershipResponse } from '@intafaced/contracts';
import type { TeamRole } from '../merchant-ops/roles.js';
import { plainTeamLabel, readStashedInviteEmail } from '../merchant-ops/team-email.js';

/**
 * The business a person is on, for svc-agents (AG-governance-01): the merchant they own, else the one team they are an
 * active member of (one active team per account). Invited and removed rows are not members.
 */
export async function teamMembershipForUser(sql: Sql, userId: string): Promise<AgentsTeamMembershipResponse> {
  const owned = await sql<Array<{ id: string; user_id: string }>>`
    SELECT id, user_id FROM pay.merchants WHERE user_id = ${userId} LIMIT 1`;
  let businessId: string;
  let ownerUserId: string;
  if (owned[0]) {
    businessId = owned[0].id;
    ownerUserId = owned[0].user_id;
  } else {
    const joined = await sql<Array<{ merchant_id: string; owner_user_id: string }>>`
      SELECT m.merchant_id, mc.user_id AS owner_user_id
        FROM pay.merchant_team_members m
        JOIN pay.merchants mc ON mc.id = m.merchant_id
       WHERE m.user_id = ${userId} AND m.status = 'active'
       LIMIT 1`;
    if (!joined[0]) return { ok: false, reason: 'no_business' };
    businessId = joined[0].merchant_id;
    ownerUserId = joined[0].owner_user_id;
  }
  const rows = await sql<Array<{ user_id: string; role: TeamRole; label: string | null }>>`
    SELECT user_id, role, label
      FROM pay.merchant_team_members
     WHERE merchant_id = ${businessId} AND status = 'active'
     ORDER BY activated_at ASC NULLS LAST, id ASC`;
  const members = [
    { userId: ownerUserId, role: 'owner' as const, label: null },
    ...rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      label: readStashedInviteEmail(r.label)?.label ?? plainTeamLabel(r.label),
    })),
  ];
  const role = members.find((m) => m.userId === userId)?.role;
  if (!role) return { ok: false, reason: 'no_business' };
  return { ok: true, businessId, role, members };
}
