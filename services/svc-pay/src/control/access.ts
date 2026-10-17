import type { Principal } from '@intafaced/auth';
import type { Sql } from 'postgres';
import { roleHasPermission, type MerchantRole } from '../merchant-ops/roles.js';

/**
 * WHO MAY SEE AND DECIDE FOR A MERCHANT — two injectable questions.
 *
 * `teamAccessPorts` (what the service mounts) answers from the merchant's team: the
 * OWNER, and active team members by role (merchant-ops/roles.ts). `canApprovePayout`
 * is the `payout.approve` permission, which `finance` and `admin` hold; with owner-only
 * access the one owner would be both maker and checker, and self-approval is refused,
 * so no payout at or above the threshold could ever be approved. `canViewMerchant` is
 * the control room's own read and request door: roles that hold `payout.request` or
 * `payout.approve` (owner, admin, finance). `developer` and `viewer` do not see caps,
 * pricing or approvals. `ownerAccessPorts` remains for owner-only wiring.
 * Both answer `false` for a merchant that does not exist or is not yours, so
 * "not yours" and "not there" look the same.
 */
export interface ControlAccessPorts {
  canViewMerchant(principal: Principal, merchantId: string): Promise<boolean>;
  canApprovePayout(principal: Principal, merchantId: string): Promise<boolean>;
}

export function ownerAccessPorts(sql: Sql): ControlAccessPorts {
  const isOwner = async (principal: Principal, merchantId: string): Promise<boolean> => {
    if (!principal?.userId) return false;
    const rows = await sql`SELECT 1 FROM pay.merchants WHERE id = ${merchantId} AND user_id = ${principal.userId}`;
    return rows.length > 0;
  };
  return { canViewMerchant: isOwner, canApprovePayout: isOwner };
}

/** The caller's role for ONE merchant: owner of that merchant, else an ACTIVE team member of it, else null. */
export async function roleOnMerchant(sql: Sql, principal: Principal, merchantId: string): Promise<MerchantRole | null> {
  if (!principal?.userId) return null;
  const owned = await sql`SELECT 1 FROM pay.merchants WHERE id = ${merchantId} AND user_id = ${principal.userId}`;
  if (owned.length > 0) return 'owner';
  const member = await sql<Array<{ role: MerchantRole }>>`
    SELECT role FROM pay.merchant_team_members
     WHERE merchant_id = ${merchantId} AND user_id = ${principal.userId} AND status = 'active'
  `;
  return member[0]?.role ?? null;
}

export function teamAccessPorts(sql: Sql): ControlAccessPorts {
  return {
    canViewMerchant: async (principal, merchantId) => {
      const role = await roleOnMerchant(sql, principal, merchantId);
      return role !== null && (roleHasPermission(role, 'payout.request') || roleHasPermission(role, 'payout.approve'));
    },
    canApprovePayout: async (principal, merchantId) => {
      const role = await roleOnMerchant(sql, principal, merchantId);
      return role !== null && roleHasPermission(role, 'payout.approve');
    },
  };
}
