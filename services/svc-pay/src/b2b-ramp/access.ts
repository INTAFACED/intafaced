import type { Sql } from 'postgres';
import type { MerchantRole, TeamRole } from '../merchant-ops/roles.js';
import { TEAM_ROLES } from '../merchant-ops/roles.js';

/**
 * Does this user own the merchant, or sit on its team?
 *
 * Missing and somebody else's merchant are both `null`, so a read cannot
 * tell them apart. The owner is `pay.merchants.user_id`. A team member
 * counts only while `pay.merchant_team_members.status` is `active`.
 */
export interface B2bRampAccess {
  roleFor(userId: string, merchantId: string): Promise<MerchantRole | null>;
}

const TEAM = new Set<string>(TEAM_ROLES);

function asTeamRole(value: string): TeamRole | null {
  return TEAM.has(value) ? (value as TeamRole) : null;
}

export function postgresB2bRampAccess(sql: Sql): B2bRampAccess {
  return {
    async roleFor(userId, merchantId) {
      if (!userId) return null;
      const owned = await sql`SELECT 1 FROM pay.merchants WHERE id = ${merchantId} AND user_id = ${userId}`;
      if (owned.length > 0) return 'owner';
      const member = await sql<Array<{ role: string }>>`
        SELECT role FROM pay.merchant_team_members
         WHERE merchant_id = ${merchantId} AND user_id = ${userId} AND status = 'active'
      `;
      const role = member[0]?.role;
      return role ? asTeamRole(role) : null;
    },
  };
}
