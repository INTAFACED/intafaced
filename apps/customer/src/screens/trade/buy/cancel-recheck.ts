/**
 * After a cancel whose reply was lost, the device note stays and blocks all trading. This is the customer-pressed
 * way out: look the order up (a READ, never a second cancel) and drop the note only once the order's state is known.
 */
import type { TradeApi } from './deps';
import { clearPending, type Pending } from './write-lock';

export type CancelRecheck =
  /** The order is known and finished (cancelled, filled, ...): the note is cleared. */
  | { kind: 'done'; status: string }
  /** The order is known and still open: the note is cleared; the customer may cancel again on purpose. */
  | { kind: 'open' }
  /** Found but still recovering: the note stays. */
  | { kind: 'checking' }
  /** Not found or the read failed: the note stays. */
  | { kind: 'unknown' };

export async function recheckCancel(api: Pick<TradeApi, 'order'>, userId: string | null, pending: Pending): Promise<CancelRecheck> {
  if (pending.kind !== 'cancel' || !pending.orderId) return { kind: 'unknown' };
  try {
    const result = await api.order({ id: pending.orderId, symbol: pending.symbol });
    if (!result.ok) return { kind: 'unknown' };
    if (result.data.recoveryRequired) return { kind: 'checking' };
    if (userId) clearPending(userId, pending.id);
    return result.data.status === 'open' ? { kind: 'open' } : { kind: 'done', status: result.data.status };
  } catch {
    return { kind: 'unknown' };
  }
}
