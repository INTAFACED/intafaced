import type { OrderChange } from '../../../features/trade/trade-api';

export type ChangeLine =
  | { key: 'Order changes amend'; at: string; amount: string; price: string }
  | { key: 'Order changes replaced by' | 'Order changes replaces'; at: string };

/** The words for one change. An amend the service gave no quantity or price for is left out, never filled in. */
export function changeLine(change: OrderChange): ChangeLine | null {
  if (change.kind === 'amend') {
    return change.quantity === null || change.price === null
      ? null
      : { key: 'Order changes amend', at: change.at, amount: change.quantity, price: change.price };
  }
  if (change.direction === 'replaced_by') return { key: 'Order changes replaced by', at: change.at };
  if (change.direction === 'replaces') return { key: 'Order changes replaces', at: change.at };
  return null;
}

/** Hands out a ticket per read; only the newest ticket is current, so an older reply that lands late is dropped. */
export function latestOnly(): { next: () => number; isCurrent: (ticket: number) => boolean; cancel: () => void } {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (ticket) => ticket === latest,
    cancel: () => {
      latest += 1;
    },
  };
}
