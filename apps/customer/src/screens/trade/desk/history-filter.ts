import type { Order } from '../../../features/trade/trade-api';

/** The three picks on the Order history tab. `all` is no filter. */
export interface HistoryFilter {
  readonly side: 'all' | Order['side'];
  readonly type: 'all' | 'market' | 'limit' | 'stop_limit' | 'stop';
  readonly status: 'all' | 'closed' | 'canceled' | 'rejected' | 'expired';
}

export const NO_HISTORY_FILTER: HistoryFilter = { side: 'all', type: 'all', status: 'all' };

export const isFiltering = (filter: HistoryFilter): boolean => filter.side !== 'all' || filter.type !== 'all' || filter.status !== 'all';

/**
 * Narrow the rows already loaded. This only hides rows; it never changes what was fetched, so a filter that matches
 * nothing is an empty list, not an error.
 */
export function filterHistory<T extends Pick<Order, 'side' | 'type' | 'status'>>(rows: readonly T[], filter: HistoryFilter): T[] {
  return rows.filter(
    (row) =>
      (filter.side === 'all' || row.side === filter.side) &&
      (filter.type === 'all' || row.type === filter.type) &&
      (filter.status === 'all' || row.status === filter.status),
  );
}
