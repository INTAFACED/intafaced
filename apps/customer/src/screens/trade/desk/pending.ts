/**
 * The saved identity of an order that may or may not have reached the service.
 *
 * Same key and shape as the old desk (`trade-pending:<userId>`), so the two screens agree: an order left
 * unconfirmed by either one blocks new orders in both until it is checked. The marker is written BEFORE the
 * order is sent and removed only when the order's outcome is known. A network failure after sending keeps it,
 * and the desk then looks the order up by its `clientOrderId` (a GET); it never sends the order again by itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { draftSchema } from '../../../features/trade/trade-api';
import { forgetReviewId } from './review-id';

export const pendingSchema = z.object({
  kind: z.enum(['place', 'cancel', 'amend', 'replace', 'convert', 'rfq', 'position', 'algo', 'copy', 'grid']),
  symbol: z.string(),
  id: z.string(),
  orderId: z.string().optional(),
  startedAt: z.number(),
  /**
   * The exact order that was being sent. Kept so a person can deliberately send the SAME order again under the SAME
   * `clientOrderId` if it never arrived: the trade service dedupes on that id, so it can never be placed twice.
   * The old desk ignores this field.
   */
  draft: draftSchema.optional(),
});
export type Pending = z.infer<typeof pendingSchema>;

export const pendingKey = (userId: string) => `trade-pending:${userId}`;
const CHANGE = 'trade-pending-change';

export type PendingState = { state: 'none' } | { state: 'pending'; value: Pending } | { state: 'unreadable' };

export function readPending(userId: string, storage: Pick<Storage, 'getItem'> = localStorage): PendingState {
  try {
    const raw = storage.getItem(pendingKey(userId));
    if (raw === null) return { state: 'none' };
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { state: 'pending', value: parsed.data } : { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
}

export type Reservation = 'reserved' | 'pending' | 'unreadable' | 'other-tab' | 'no-locks' | 'no-storage';

/**
 * Take the account's order slot and write the marker, atomically across tabs (Web Locks). Refuses when another
 * tab holds the slot, when a marker is already there (unconfirmed order) or unreadable, and when this browser
 * cannot lock or store: an order whose identity cannot be saved must not be sent.
 */
export async function reserve(userId: string, value: Pending): Promise<Reservation> {
  if (!navigator.locks) return 'no-locks';
  return new Promise<Reservation>((resolve) => {
    void navigator.locks.request(`trade-account:${userId}`, { ifAvailable: true }, (lock) => {
      if (!lock) return resolve('other-tab');
      const existing = readPending(userId);
      if (existing.state === 'pending') return resolve('pending');
      if (existing.state === 'unreadable') return resolve('unreadable');
      try {
        localStorage.setItem(pendingKey(userId), JSON.stringify(pendingSchema.parse(value)));
      } catch {
        return resolve('no-storage');
      }
      window.dispatchEvent(new Event(CHANGE));
      resolve('reserved');
    });
  });
}

/**
 * Remove the marker, only if it is still the one this call wrote. Releasing is how every path ends an order whose
 * outcome is known (placed, refused, found by a check, sent again), so the reviewed-draft number is dropped here too:
 * the next identical draft is a new order.
 */
export function release(userId: string, id: string): void {
  forgetReviewId(id);
  const current = readPending(userId);
  // Only the marker this order wrote. A different one, or one that cannot be read, stays.
  if (current.state === 'unreadable' || (current.state === 'pending' && current.value.id !== id)) return;
  try {
    localStorage.removeItem(pendingKey(userId));
  } catch {
    /* The marker stays; the person will be asked to check, which is the safe side. */
  }
  window.dispatchEvent(new Event(CHANGE));
}

/** The marker for this user, live across tabs and across the old and new desk. */
export function usePendingOrder(userId: string | null): PendingState {
  const read = useCallback((): PendingState => (userId ? readPending(userId) : { state: 'none' }), [userId]);
  const [state, setState] = useState<PendingState>(read);
  useEffect(() => {
    const update = () => setState(read());
    update();
    window.addEventListener('storage', update);
    window.addEventListener(CHANGE, update);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener(CHANGE, update);
    };
  }, [read]);
  return state;
}

/**
 * Orders this tab is sending right now. The lookup for an unconfirmed order must not run while its own request is
 * still in flight (it would report "not found" for an order that is about to arrive).
 */
const inFlight = new Set<string>();
const announce = (): void => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE));
};
export const markInFlight = (id: string): void => {
  inFlight.add(id);
  announce();
};
export const unmarkInFlight = (id: string): void => {
  inFlight.delete(id);
  announce();
};
export const isInFlight = (id: string): boolean => inFlight.has(id);

const CHECK_NOW = 'trade-pending-check';
/** Ask the desk to look the unconfirmed order up now. */
export const requestCheck = (): void => void window.dispatchEvent(new Event(CHECK_NOW));
export const onCheckRequested = (listener: () => void): (() => void) => {
  window.addEventListener(CHECK_NOW, listener);
  return () => window.removeEventListener(CHECK_NOW, listener);
};
