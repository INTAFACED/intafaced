/**
 * One money request at a time, and a note that survives a reload (UI-SPEC principle 6: reuse the safety layer).
 *
 * The old desk writes `trade-pending:<userId>` to device storage before it sends an order or a conversion, holds
 * a browser lock named `trade-account:<userId>` while it runs, and removes the note only once the outcome is known.
 * A network failure leaves the note, and every trade screen refuses new orders until the original is checked.
 * This file writes the same key in the same shape, so the old desk and these screens guard each other.
 *
 * Nothing here retries. A request is sent once; an unknown outcome is surfaced, never re-sent by code.
 */
import { z } from 'zod';

const pendingSchema = z.object({
  kind: z.enum(['place', 'cancel', 'amend', 'replace', 'convert', 'rfq', 'position', 'algo', 'copy', 'grid']),
  symbol: z.string(),
  id: z.string(),
  orderId: z.string().optional(),
  startedAt: z.number(),
});
export type Pending = z.infer<typeof pendingSchema>;

export const pendingKey = (userId: string) => `trade-pending:${userId}`;
export const lockName = (userId: string) => `trade-account:${userId}`;

export type PendingState =
  | { state: 'none' }
  | { state: 'pending'; pending: Pending }
  /** Storage throws or holds something unreadable: treated as a blocker, never as "nothing pending". */
  | { state: 'unreadable' };

export function readPending(userId: string | null): PendingState {
  if (!userId) return { state: 'none' };
  try {
    const raw = localStorage.getItem(pendingKey(userId));
    if (raw === null) return { state: 'none' };
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { state: 'pending', pending: parsed.data } : { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
}

/** Remove the note, but only if it is still ours: an older result must never clear a newer request. */
export function clearPending(userId: string, id: string): boolean {
  const current = readPending(userId);
  if (current.state !== 'pending' || current.pending.id !== id) return false;
  try {
    localStorage.removeItem(pendingKey(userId));
    window.dispatchEvent(new Event('trade-pending-change'));
    return true;
  } catch {
    return false;
  }
}

export type BlockReason = 'signedOut' | 'pending' | 'unreadable' | 'storage' | 'otherTab' | 'noLocks';

export type Guarded<T> = { kind: 'blocked'; reason: BlockReason; pending?: Pending } | { kind: 'ran'; value: T } | { kind: 'threw' };

/**
 * Run one request under the lock and the note.
 * - `keep(value)` says whether the outcome is still unknown; if so the note stays after the call.
 * - `recheck` lets the same request run again over its own note (a customer-pressed "check again" on an
 *   idempotent call); any other note blocks.
 */
export async function runGuarded<T>(
  userId: string | null,
  pending: Pending,
  call: () => Promise<T>,
  keep: (value: T) => boolean,
  options: { recheck?: boolean } = {},
): Promise<Guarded<T>> {
  if (!userId) return { kind: 'blocked', reason: 'signedOut' };
  if (typeof navigator === 'undefined' || !navigator.locks) return { kind: 'blocked', reason: 'noLocks' };
  let outcome: Guarded<T> = { kind: 'blocked', reason: 'otherTab' };
  try {
    await navigator.locks.request(lockName(userId), { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const existing = readPending(userId);
      if (existing.state === 'unreadable') {
        outcome = { kind: 'blocked', reason: 'unreadable' };
        return;
      }
      if (existing.state === 'pending' && !(options.recheck && existing.pending.id === pending.id)) {
        outcome = { kind: 'blocked', reason: 'pending', pending: existing.pending };
        return;
      }
      try {
        if (existing.state === 'none') {
          localStorage.setItem(pendingKey(userId), JSON.stringify(pendingSchema.parse(pending)));
          window.dispatchEvent(new Event('trade-pending-change'));
        }
      } catch {
        // Without a saved note an unknown outcome could not be found again, so nothing is sent.
        outcome = { kind: 'blocked', reason: 'storage' };
        return;
      }
      try {
        const value = await call();
        if (!keep(value)) clearPending(userId, pending.id);
        outcome = { kind: 'ran', value };
      } catch {
        outcome = { kind: 'threw' };
      }
    });
  } catch {
    return { kind: 'threw' };
  }
  return outcome;
}
