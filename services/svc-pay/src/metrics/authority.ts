import { PayError } from '../payment-service.js';
import { assertMerchantAreaAccess, type MerchantAreaFence } from '../merchant-ownership.js';
import type { PayService } from '../payment-service.js';
import type { PermissionArea } from '../submerchants.js';
import { merchantNotFound } from './errors.js';

/**
 * Metrics span payments, refunds-by-payment and settlements, so a PayFac parent
 * reading a sub-merchant's snapshot needs BOTH of these areas over it. A parent
 * granted only `payment` does not see settlement figures or fee revenue; it gets
 * the named `pay.submerchant_permission_denied` (it is already inside the tree, so
 * that reveals nothing). The merchant itself holds every area over its own node.
 */
export const METRICS_AREAS: readonly PermissionArea[] = ['payment', 'settlement'];

export interface MerchantMetricsAuthority {
  /** Resolves, or throws `MetricsError('pay.merchant_not_found')` / `PayError('pay.submerchant_permission_denied')`. */
  assertCanRead(principalUserId: string | undefined, merchantId: string): Promise<void>;
}

/**
 * M1 — NO EXISTENCE LEAK. Reuses the ownership + PayFac area helper that every
 * other scoped merchant read uses, then collapses its three "you may not" answers
 * (unknown id, someone else's merchant, outside your tree) into one, byte for
 * byte, so A asking for B's id gets what A gets for an id that does not exist.
 * Only a named missing area inside the caller's own tree stays distinguishable.
 */
export function createMerchantMetricsAuthority(
  pay: Pick<PayService, 'getMerchant' | 'getMerchantByUserId'>,
  trees: MerchantAreaFence | null,
): MerchantMetricsAuthority {
  return {
    async assertCanRead(principalUserId, merchantId) {
      try {
        for (const area of METRICS_AREAS) await assertMerchantAreaAccess(pay, principalUserId, merchantId, area, trees);
      } catch (err) {
        if (err instanceof PayError && (err.code === 'pay.merchant_not_found' || err.code === 'pay.merchant_forbidden'))
          throw merchantNotFound();
        throw err;
      }
    },
  };
}
