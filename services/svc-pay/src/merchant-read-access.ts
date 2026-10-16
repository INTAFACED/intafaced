import { PayError } from './payment-service.js';
import { roleHasPermission } from './merchant-ops/roles.js';
import type { TeamRole } from './merchant-ops/roles.js';
import type { MerchantReadPermission, MerchantTeamRead } from './merchant-team-read.js';

/** Who passed the read. Owner (and a PayFac area grant) keep the full record. A stored role is projected. */
export type MerchantReadAudience = 'owner' | TeamRole;

/**
 * Owner (and PayFac area) first. An active team member of THIS merchant is the
 * only other yes, and only for a read permission their role holds. Everyone
 * else gets the same not-found the owner check already threw, including a
 * member of a different merchant.
 */
export async function allowMerchantRead(input: {
  ownerCheck: () => Promise<void>;
  team: MerchantTeamRead | null | undefined;
  userId: string | undefined;
  merchantId: string;
  permission: MerchantReadPermission;
}): Promise<MerchantReadAudience> {
  try {
    await input.ownerCheck();
    return 'owner';
  } catch (err) {
    if (!(err instanceof PayError) || err.code !== 'pay.merchant_not_found') throw err;
    const role = input.team ? await input.team.activeRole(input.userId, input.merchantId) : null;
    if (!role || !roleHasPermission(role, input.permission)) throw err;
    return role;
  }
}
