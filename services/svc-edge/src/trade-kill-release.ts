/**
 * What a killed trade module still lets out, and what it must not book.
 *
 * The kill switch allows `orders.cancel`, `orders.cancelAll`, and
 * `orders.massCancel`. This book is the hold arithmetic for that release:
 * a partly filled order releases its remaining hold, and a second cancel-all
 * does not release that hold again. A new order on a killed module is refused
 * before any hold is recorded.
 */
import type { KillSwitchState } from './kill-switch.js';

export interface OpenOrderHold {
  readonly id: string;
  readonly userId: string;
  readonly originalHold: string;
  readonly remainingHold: string;
}

export class CallerOpenOrders {
  private readonly rows = new Map<string, OpenOrderHold & { status: 'open' | 'cancelled' }>();

  open(order: OpenOrderHold): void {
    this.rows.set(order.id, { ...order, status: 'open' });
  }

  status(id: string): 'open' | 'cancelled' | null {
    return this.rows.get(id)?.status ?? null;
  }

  /** Release each still-open remaining hold once. A later call returns nothing. */
  releaseRemaining(userId: string): { id: string; amount: string }[] {
    const released: { id: string; amount: string }[] = [];
    for (const row of this.rows.values()) {
      if (row.userId !== userId || row.status !== 'open') continue;
      released.push({ id: row.id, amount: row.remainingHold });
      this.rows.set(row.id, { ...row, status: 'cancelled' });
    }
    return released;
  }
}

export function placeWhileTradeMayBeKilled(
  state: KillSwitchState,
  book: CallerOpenOrders,
  order: OpenOrderHold,
): { refused: true } | { refused: false } {
  if (state.decide('/api/trade/trpc/orders.create', 'POST').refused) return { refused: true };
  book.open(order);
  return { refused: false };
}

export function cancelAllWhileTradeMayBeKilled(
  state: KillSwitchState,
  book: CallerOpenOrders,
  userId: string,
): { refused: true; released: [] } | { refused: false; released: { id: string; amount: string }[] } {
  if (state.decide('/api/trade/trpc/orders.cancelAll', 'POST').refused) return { refused: true, released: [] };
  return { refused: false, released: book.releaseRemaining(userId) };
}
