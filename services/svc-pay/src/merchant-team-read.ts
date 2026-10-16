import type { Sql } from 'postgres';
import { roleHasPermission, type MerchantPermission, type TeamRole } from './merchant-ops/roles.js';

/** Reads a team member may hold. Owner access is decided before this is asked. */
export type MerchantReadPermission = 'payments.read' | 'settlements.read' | 'halts.read';

const STORED_ROLES = new Set<TeamRole>(['admin', 'finance', 'developer', 'viewer']);

export interface MerchantTeamRead {
  /**
   * True when `userId` is an ACTIVE member of `merchantId` and that role holds
   * `permission`. Missing merchant, invited, removed, and another merchant's
   * member are all false, so the caller cannot tell those apart.
   */
  allows(userId: string | undefined, merchantId: string, permission: MerchantReadPermission): Promise<boolean>;
}

export function teamReadFromSql(sql: Sql): MerchantTeamRead {
  return {
    async allows(userId, merchantId, permission) {
      if (!userId) return false;
      const rows = await sql<Array<{ role: string }>>`
        SELECT role FROM pay.merchant_team_members
         WHERE merchant_id = ${merchantId} AND user_id = ${userId} AND status = 'active'
         LIMIT 1`;
      const role = rows[0]?.role;
      if (!role || !STORED_ROLES.has(role as TeamRole)) return false;
      return roleHasPermission(role as TeamRole, permission as MerchantPermission);
    },
  };
}
