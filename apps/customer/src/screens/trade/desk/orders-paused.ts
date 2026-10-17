/**
 * "Orders are paused": set when the service refuses an order because the ledger behind it is frozen, cleared by the next order
 * it accepts. The data-status chip reads it, so the desk does not look ready to trade while every order is being refused.
 * Buy and Sell stay pressable on purpose: trying again is the only way the desk learns the pause has ended.
 */
import { useSyncExternalStore } from 'react';

let pausedAt: number | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const markOrdersPaused = (): void => {
  pausedAt = Date.now();
  emit();
};
export const clearOrdersPaused = (): void => {
  if (pausedAt === null) return;
  pausedAt = null;
  emit();
};
export const useOrdersPaused = (): boolean =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    () => pausedAt !== null,
  );
