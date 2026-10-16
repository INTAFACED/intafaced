import type { Sql } from 'postgres';
import { capabilityFlags, pricingVisibilityFor, TEAM_ROLES, type MerchantRole } from '../merchant-ops/roles.js';

const STORED = new Set<string>(TEAM_ROLES);

/**
 * The caller's merchant memberships.
 *
 * A row is included only when `pay.merchants.user_id` is the caller (owner) or
 * `pay.merchant_team_members` has an active stored role for the caller. An
 * invited or removed row is not a membership. A merchant the caller does not
 * own and is not on the team of is not listed, including one they happen to
 * know the id of. `merchantOps.team.me` is a single resolved merchant and is
 * not this list.
 */
export async function listMyAccess(sql: Sql, userId: string) {
  const rows = await sql<
    Array<{
      id: string;
      role: string;
      status: 'pending' | 'active' | 'suspended' | 'closed';
      kyb_status: 'none' | 'pending' | 'approved' | 'rejected';
      mode: 'gateway' | 'psp' | 'payfac';
      display_name: string | null;
      legal_name: string | null;
    }>
  >`
    SELECT id, role, status::text AS status, kyb_status::text AS kyb_status, mode::text AS mode, display_name, legal_name
      FROM (
        SELECT m.id, 'owner'::text AS role, m.status, m.kyb_status, m.mode, m.display_name, m.legal_name, 0 AS ord
          FROM pay.merchants m
         WHERE m.user_id = ${userId}
        UNION ALL
        SELECT m.id, t.role, m.status, m.kyb_status, m.mode, m.display_name, m.legal_name, 1 AS ord
          FROM pay.merchant_team_members t
          JOIN pay.merchants m ON m.id = t.merchant_id
         WHERE t.user_id = ${userId}
           AND t.status = 'active'
           AND t.role IN ('admin', 'finance', 'developer', 'viewer')
           AND m.user_id IS DISTINCT FROM ${userId}
      ) memberships
     ORDER BY ord, id`;
  return {
    memberships: rows.flatMap((row) => {
      if (row.role !== 'owner' && !STORED.has(row.role)) return [];
      const role = row.role as MerchantRole;
      return [
        {
          merchantId: row.id,
          role,
          status: row.status,
          kybStatus: row.kyb_status,
          verified: row.kyb_status === 'approved',
          mode: row.mode,
          displayName: row.display_name,
          legalName: row.legal_name,
          capabilities: capabilityFlags(role),
          pricingVisibility: pricingVisibilityFor(role),
        },
      ];
    }),
  };
}
