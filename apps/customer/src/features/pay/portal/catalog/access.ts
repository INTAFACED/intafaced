import { useMerchantAccess } from '../access/MerchantAccess';

/** Whether this person may add products here: the role table says so, and the business is verified (the service's rule too). */
export function useMayAddProducts(): { allowed: boolean; unverified: boolean } {
  const { access, can } = useMerchantAccess();
  const unverified = access.status === 'ready' && access.kybStatus !== 'approved';
  return { allowed: can('products.manage') && !unverified, unverified: can('products.manage') && unverified };
}
