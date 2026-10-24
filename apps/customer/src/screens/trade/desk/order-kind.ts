import type { Order } from '../../../features/trade/trade-api';
import { scaled } from './order-math';
import { orderTag } from './tif';

/**
 * Only a plain resting limit order can be changed here: GTC or post-only, still open, nothing waiting on a check.
 * An order with linked exit legs (an OCO, or the exit a bracket placed) is not plain: a price change replaces it with
 * a bare limit order and would silently drop the other leg. Nor is an OTO buy: its close is placed when it fills, and a
 * replacement would leave the close behind with the cancelled buy (the service refuses it).
 */
export function canEdit(order: Order): boolean {
  const tag = orderTag(order);
  return (
    !order.exit &&
    order.linked?.role !== 'entry' &&
    order.type === 'limit' &&
    order.status === 'open' &&
    !order.recoveryRequired &&
    order.price !== null &&
    (tag === null || tag === 'PO')
  );
}

/** Copy key for the kind an order with linked exit legs shows in the orders tables. */
export const exitKindKey = (kind: 'oco' | 'bracket_exit'): 'Order type oco' | 'Order type bracket exit' =>
  kind === 'oco' ? 'Order type oco' : 'Order type bracket exit';

/**
 * A stop that has not fired can have its trigger changed (J-cex-spot-08 #3): a stop-limit or a stop-market, still open,
 * nothing filled, no linked legs, the trigger stated and known not to have fired. The change is a replacement: the
 * service cancels the stop and places a new one, so an order whose trigger state is unknown is never offered it.
 */
export function canEditStop(order: Order): boolean {
  return (
    !order.exit &&
    (order.type === 'stop_limit' || order.type === 'stop') &&
    order.status === 'open' &&
    !order.recoveryRequired &&
    order.triggered === null &&
    !!order.stopPrice &&
    order.price !== null &&
    scaled(order.filled) === 0n
  );
}
