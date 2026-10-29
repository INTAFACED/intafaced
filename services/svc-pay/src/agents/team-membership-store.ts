import type { Sql } from 'postgres';
import type { AgentsTeamMembershipResponse } from '@intafaced/contracts';
import { SHUT } from '../owner-pay-grant-recheck.js';
import type { MerchantRole, TeamRole } from '../merchant-ops/roles.js';
import { plainTeamLabel, readStashedInviteEmail } from '../merchant-ops/team-email.js';

type MerchantStatus = 'pending' | 'active' | 'suspended' | 'closed';

/** The label the team list shows (`view()` in merchant-ops/team.ts): a claim stash shows its visible part, never the token. */
function visibleLabel(label: string | null): string | null {
  const stashed = readStashedInviteEmail(label);
  return stashed ? stashed.label : plainTeamLabel(label);
}

/**
 * The business a person is on, for svc-agents (AG-governance-01): the merchant they own, else the one team they are an
 * active member of (one active team per account), the same order `resolveMerchantCaller` uses. Invited and removed rows
 * are not members. A shut merchant grants nothing to its owner or its team, so it answers `business_shut`.
 */
export async function teamMembershipForUser(sql: Sql, userId: string): Promise<AgentsTeamMembershipResponse> {
  const [found] = await sql<Array<{ id: string; user_id: string; status: MerchantStatus; role: MerchantRole }>>`
    SELECT id, user_id, status, role FROM (
      SELECT mc.id, mc.user_id, mc.status, 'owner' AS role, 0 AS rank FROM pay.merchants mc WHERE mc.user_id = ${userId}
      UNION ALL
      SELECT mc.id, mc.user_id, mc.status, m.role, 1 AS rank
        FROM pay.merchant_team_members m
        JOIN pay.merchants mc ON mc.id = m.merchant_id
       WHERE m.user_id = ${userId} AND m.status = 'active'
    ) found
    ORDER BY rank
    LIMIT 1`;
  if (!found) return { ok: false, reason: 'no_business' };
  if (SHUT.has(found.status)) return { ok: false, reason: 'business_shut' };
  const rows = await sql<Array<{ user_id: string; role: TeamRole; label: string | null }>>`
    SELECT user_id, role, label
      FROM pay.merchant_team_members
     WHERE merchant_id = ${found.id} AND status = 'active'
     ORDER BY activated_at ASC NULLS LAST, id ASC`;
  return {
    ok: true,
    businessId: found.id,
    role: found.role,
    members: [
      { userId: found.user_id, role: 'owner', label: null },
      ...rows.map((r) => ({ userId: r.user_id, role: r.role, label: visibleLabel(r.label) })),
    ],
  };
}
