import { useOptionalMerchantAccess } from '../access/MerchantAccess';

/** True when the account runs on test money: its business is not yet approved, so every figure is practice. */
export function useTestMode(): boolean {
  const access = useOptionalMerchantAccess()?.access;
  return access?.status === 'ready' && access.kybStatus !== null && access.kybStatus !== 'approved';
}
