import type { ApiResult } from '../../../shared/api';
import type { StatusFeed } from '../../developers/developers-api';
import { isTerminalOrder, type Order } from '../trade-api';

/** Most open orders one read lists. A full page may be only the first page of the account's orders, so the room says "at least". */
export const OPEN_ORDERS_LIMIT = 200;

export type OpenOrders = {
  readonly total: number;
  /** True when the read came back full: there may be more open orders than are counted. */
  readonly capped: boolean;
  readonly markets: ReadonlyArray<{ readonly symbol: string; readonly count: number }>;
};

/** What is open now, by market, in the order the markets first appear. Finished orders are never counted. */
export function summariseOpenOrders(orders: readonly Order[], limit: number = OPEN_ORDERS_LIMIT): OpenOrders {
  const open = orders.filter((order) => !isTerminalOrder(order));
  const counts = new Map<string, number>();
  for (const order of open) counts.set(order.symbol, (counts.get(order.symbol) ?? 0) + 1);
  return {
    total: open.length,
    capped: orders.length >= limit,
    markets: [...counts].map(([symbol, count]) => ({ symbol, count })),
  };
}

export type CancelEverythingVerdict =
  | { readonly kind: 'done'; readonly cancelled: number }
  | { readonly kind: 'partial'; readonly cancelled: number; readonly left: number }
  /** The answer did not say what happened. Nothing is sent again; the open orders are read again. */
  | { readonly kind: 'uncertain' };

/** Reads the answer to one "cancel every open order" call against the count that was confirmed. */
export function judgeCancelEverything(expected: number, reply: ApiResult<Order[]>): CancelEverythingVerdict {
  if (!reply.ok) return { kind: 'uncertain' };
  const cancelled = reply.data.filter(isTerminalOrder).length;
  return cancelled >= expected ? { kind: 'done', cancelled } : { kind: 'partial', cancelled, left: expected - cancelled };
}

/** Incidents the platform has opened and not resolved, from the public status feed. */
export function openIncidents(feed: StatusFeed): StatusFeed['incidents'] {
  return feed.incidents.filter((incident) => incident.resolvedAt === null);
}
