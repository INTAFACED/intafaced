import { Badge, StatusTag, type StatusKind } from '@intafaced/ui';
import { isPositive } from '../../../data/decimal';
import type { FuturesOrder, FuturesOrderOrigin } from './api';
import { futuresRefusal } from './refusals';
import { tabsCopy } from './tabs-copy';

/** States in which an order may still rest or fill, so a cancel is offered. `submit_unknown` is asked of the book first. */
export const LIVE_ORDER_STATES = new Set(['pending', 'held', 'submitting', 'open', 'submit_unknown']);

/** Whether the trader may cancel it: a live order of theirs. A liquidation order is the venue's own. */
export function cancellable(order: FuturesOrder): boolean {
  return LIVE_ORDER_STATES.has(order.status) && order.origin !== 'liquidation';
}

export function orderStatusKind(order: FuturesOrder): StatusKind {
  if (order.status === 'filled') return 'filled';
  if (order.status === 'submit_unknown') return 'pending';
  if (LIVE_ORDER_STATES.has(order.status)) return 'working';
  if (order.status === 'cancelled') return isPositive(order.filledQty) ? 'filled' : 'cancelled';
  return 'failed';
}

/**
 * One futures order's state in words, with the service's refusal under it. The desk's Orders tab and the orders room
 * both show this, so an order reads the same in both places.
 */
export function FuturesOrderStatus({ order }: { order: FuturesOrder }) {
  const { t } = tabsCopy.useCopy();
  const words: Record<string, string> = {
    pending: t('Order working'),
    held: t('Order working'),
    submitting: t('Order working'),
    open: t('Order resting'),
    submit_unknown: t('Order checking'),
    filled: t('Order filled'),
    cancelled: t('Order cancelled'),
    rejected: t('Order rejected'),
    refused: t('Order rejected'),
  };
  const word = order.status === 'cancelled' && isPositive(order.filledQty) ? t('Order part filled') : (words[order.status] ?? order.status);
  return (
    <span className="flex flex-col">
      <StatusTag status={orderStatusKind(order)} label={word} />
      {order.refusalCode ? <span className="text-2xs text-fg-3">{futuresRefusal({ code: order.refusalCode }).title}</span> : null}
    </span>
  );
}

/** Who placed the order, and the trader's label on it. An order from before origins were kept reads as the trader's. */
export function FuturesOrderOrigin({ origin, label }: { origin: FuturesOrderOrigin | null | undefined; label?: string | null }) {
  const { t } = tabsCopy.useCopy();
  const kind = origin ?? 'user';
  return (
    <span className="flex flex-wrap items-center gap-1" data-origin={kind}>
      <Badge variant={kind === 'user' ? 'outline' : 'soft'} tone={kind === 'liquidation' ? 'down' : 'neutral'}>
        {t(`Origin ${kind}`)}
      </Badge>
      {label ? (
        <Badge variant="outline" data-label={label}>
          {label}
        </Badge>
      ) : null}
    </span>
  );
}
