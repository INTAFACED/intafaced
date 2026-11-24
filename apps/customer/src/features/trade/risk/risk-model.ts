import type { ApiResult } from '../../../shared/api';
import type { StatusFeed } from '../../../shared/notify-reads';
import { isTerminalOrder, type Order } from '../trade-api';
import type { VenueOrder, VenuePosition } from '../venue-api';
import type { ActionResult } from '../venue/VenueKit';

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
  | { readonly kind: 'uncertain' }
  /** Nothing was sent, or the venue refused the whole request: nothing was cancelled, in the words of who said no. */
  | {
      readonly kind: 'refused';
      readonly reason: 'wallet_rejected' | 'wallet_failed' | 'waiting' | 'no_batch' | 'venue';
      readonly detail: string;
    };

/** Reads the answer to one "cancel every open order" call against the count that was confirmed. */
export function judgeCancelEverything(expected: number, reply: ApiResult<Order[]>): CancelEverythingVerdict {
  if (!reply.ok) return { kind: 'uncertain' };
  const cancelled = reply.data.filter(isTerminalOrder).length;
  return cancelled >= expected ? { kind: 'done', cancelled } : { kind: 'partial', cancelled, left: expected - cancelled };
}

/** A venue order still resting: open or part filled, with the venue's client id a cancel names it by. */
export function isLiveVenueOrder(order: VenueOrder): boolean {
  return (order.status === 'open' || order.status === 'partially_filled') && Boolean(order.venueClientOrderId);
}

/** The venue account's open orders, by market. The venue lists them all in one read, so the count is never cut. */
export function summariseVenueOrders(orders: readonly VenueOrder[]): OpenOrders {
  const counts = new Map<string, number>();
  const open = orders.filter(isLiveVenueOrder);
  for (const order of open) counts.set(order.symbol, (counts.get(order.symbol) ?? 0) + 1);
  return { total: open.length, capped: false, markets: [...counts].map(([symbol, count]) => ({ symbol, count })) };
}

/** The venue positions that are open: a size of zero is no position. */
export function openVenuePositions(positions: readonly VenuePosition[]): VenuePosition[] {
  return positions.filter((position) => !/^0(\.0*)?$/.test(position.size));
}

/** The ids one signed cancel names, in batches of at most what the venue takes in one action. */
export function cancelBatches<T>(ids: readonly T[], most: number): T[][] {
  if (most < 1) return [];
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += most) out.push(ids.slice(i, i + most));
  return out;
}

/**
 * Reads the venue's answers to the signed cancels against the count that was confirmed. Only a leg the venue accepted counts
 * as cancelled; an answer with no definite outcome makes the whole result uncertain (nothing is sent again); a first request
 * refused or never signed cancelled nothing.
 */
export function judgeVenueCancel(expected: number, answers: readonly ActionResult[]): CancelEverythingVerdict {
  let cancelled = 0;
  for (const [i, answer] of answers.entries()) {
    if (answer.kind === 'unknown') return { kind: 'uncertain' };
    if (answer.kind === 'outcome' && answer.outcome.accepted) {
      cancelled += (answer.outcome.legs ?? []).filter((leg) => leg.accepted).length;
      continue;
    }
    if (i > 0 || cancelled > 0) break;
    if (answer.kind === 'rejected') return { kind: 'refused', reason: 'wallet_rejected', detail: '' };
    if (answer.kind === 'waiting') return { kind: 'refused', reason: 'waiting', detail: '' };
    if (answer.kind === 'wallet_failed') return { kind: 'refused', reason: 'wallet_failed', detail: answer.message };
    if (answer.kind === 'refused') return { kind: 'refused', reason: 'venue', detail: answer.message };
    if (answer.kind === 'outcome' && !answer.outcome.accepted)
      return { kind: 'refused', reason: 'venue', detail: answer.outcome.refusal.detail };
  }
  return cancelled >= expected ? { kind: 'done', cancelled } : { kind: 'partial', cancelled, left: expected - cancelled };
}

/** Incidents the platform has opened and not resolved, from the public status feed. */
export function openIncidents(feed: StatusFeed): StatusFeed['incidents'] {
  return feed.incidents.filter((incident) => incident.resolvedAt === null);
}
