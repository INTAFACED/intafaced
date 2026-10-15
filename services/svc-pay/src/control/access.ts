import type { Principal } from '@intafaced/auth';
import type { Sql } from 'postgres';

/**
 * WHO MAY SEE AND DECIDE FOR A MERCHANT — two injectable questions.
 *
 * `canApprovePayout` is the seam W15 (team roles) wires: a `finance` team member
 * holds `payout.approve`. Until then the default is the merchant OWNER, which is
 * the existing ownership rule (merchant-ownership.ts). Both answer `false` for a
 * merchant that does not exist, so "not yours" and "not there" look the same.
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
