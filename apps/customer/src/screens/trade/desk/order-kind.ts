import type { Order } from '../../../features/trade/trade-api';
import { orderTag } from './tif';

/**
 * Only a plain resting limit order can be changed here: GTC or post-only, still open, nothing waiting on a check.
 * An order with linked exit legs (an OCO, or the exit a bracket placed) is not plain: a price change replaces it with
 * a bare limit order and would silently drop the other leg.
 */
export function canEdit(order: Order): boolean {
  const tag = orderTag(order);
  return (
    !order.exit &&
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
