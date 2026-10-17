/** Pure helpers for the "Your orders" panel: which rows show, in what order, and the one word for each status. */
import type { Order } from './deps';
import { dec } from './trade-math';

export const MAX_ORDER_ROWS = 20;

export type OrderStatusWord = 'open' | 'partly' | 'filled' | 'cancelled' | 'rejected' | 'expired' | 'checking';

/** The status word for an order, or null for a status we do not know (the cell then shows "—"). */
export function statusWord(order: Pick<Order, 'status' | 'filled' | 'remaining' | 'recoveryRequired'>): OrderStatusWord | null {
  if (order.recoveryRequired) return 'checking';
  switch (order.status) {
    case 'open': {
      const filled = dec(order.filled);
      const remaining = dec(order.remaining);
      return filled !== null && filled > 0n && remaining !== null && remaining > 0n ? 'partly' : 'open';
    }
    case 'closed':
      return 'filled';
    case 'canceled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    default:
      return null;
  }
}

/** A cancel only makes sense for an order that is still working and is not being checked. */
export function canCancel(order: Pick<Order, 'status' | 'recoveryRequired'>): boolean {
  return order.status === 'open' && !order.recoveryRequired;
}

/**
 * Open orders first, then the newest closed ones, at most 20 in all, each order once. Orders being checked
 * stay with the open ones (their outcome is not known yet), whichever list they came from.
 */
export function pickRows(open: readonly Order[], closed: readonly Order[], limit = MAX_ORDER_ROWS): Order[] {
  const seen = new Set<string>();
  const unique = (rows: readonly Order[]) =>
    rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true))).sort((a, b) => b.timestamp - a.timestamp);
  const working = unique([...open, ...closed.filter((row) => row.recoveryRequired)]);
  const finished = unique(closed);
  return [...working, ...finished].slice(0, limit);
}

/** The coin of a market symbol: "BTC/USDT" is "BTC". The whole symbol when it has no slash. */
export function baseOf(symbol: string): string {
  return symbol.split('/')[0] ?? symbol;
}
