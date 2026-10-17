import { useSyncExternalStore } from 'react';
import type { MerchantAccessValue } from './MerchantAccess';

/**
 * The top bar lives above the page, outside the access provider. The provider publishes its value here so the bar
 * can show the business name and status without a second round of reads. Null until a portal page has mounted.
 */
let current: MerchantAccessValue | null = null;
const listeners = new Set<() => void>();

export function publishAccess(value: MerchantAccessValue | null) {
  current = value;
  for (const listener of listeners) listener();
}
export function useSharedAccess(): MerchantAccessValue | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
    () => null,
  );
}
