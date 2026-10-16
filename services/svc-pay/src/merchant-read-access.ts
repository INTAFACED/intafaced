import { PayError } from './payment-service.js';
import type { MerchantReadPermission, MerchantTeamRead } from './merchant-team-read.js';

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
}): Promise<void> {
  try {
    await input.ownerCheck();
  } catch (err) {
    if (!(err instanceof PayError) || err.code !== 'pay.merchant_not_found') throw err;
    const allowed = input.team ? await input.team.allows(input.userId, input.merchantId, input.permission) : false;
    if (!allowed) throw err;
  }
}
