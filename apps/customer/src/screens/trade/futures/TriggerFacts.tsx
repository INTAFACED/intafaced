import type { StatusKind } from '@intafaced/ui';
import { fmtAmount, fmtPrice } from '../../../data/format';
import type { ConditionalOrder } from './api';
import { futuresRefusal } from './refusals';
import { triggersCopy } from './triggers-copy';

type T = ReturnType<typeof triggersCopy.useCopy>['t'];

const CANCEL_REASONS = ['replaced', 'position_closed', 'position_gone', 'cancelled', 'linked'] as const;
type CancelReason = (typeof CANCEL_REASONS)[number];
const isCancelReason = (reason: string): reason is CancelReason => (CANCEL_REASONS as readonly string[]).includes(reason);

export function triggerStatus(order: ConditionalOrder): StatusKind {
  switch (order.status) {
    case 'armed':
      return 'pending';
    case 'triggered':
      return 'working';
    case 'filled':
      return 'filled';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
  }
}

/** What the order is: a position's take profit or stop loss, or a free-standing stop by its kind. */
export function triggerKind(order: ConditionalOrder, t: T): string {
  return order.attachment ? t(`Kind ${order.attachment}`) : t(`Kind ${order.kind}`);
}

export function triggerLine(order: ConditionalOrder, t: T): string | null {
  return order.triggerPrice === null
    ? null
    : t('Trigger', { price: fmtPrice(order.triggerPrice, null), source: t(`Source ${order.triggerSource ?? 'mark'}`) });
}

/** The lines under an order's status: what a fired one closed and through which order, and why one stopped. */
export function TriggerFacts({ order }: { order: ConditionalOrder }) {
  const { t } = triggersCopy.useCopy();
  const cancel =
    order.status === 'cancelled' && order.cancelReason
      ? isCancelReason(order.cancelReason)
        ? t(`Cancel ${order.cancelReason}`)
        : t('Cancel other', { reason: order.cancelReason })
      : null;
  const failure = order.status === 'failed' ? futuresRefusal({ code: order.failureReason ?? undefined }) : null;
  return (
    <>
      {order.firedQuantity ? (
        <span className="text-fg-2">
          {t('Fired', {
            qty: fmtAmount(order.firedQuantity, { places: 8 }),
            closed: fmtAmount(order.closedQuantity ?? '0', { places: 8 }),
          })}
        </span>
      ) : null}
      {order.closeOrderId ? <span className="text-2xs text-fg-3">{t('Close order', { id: order.closeOrderId })}</span> : null}
      {cancel ? <span className="text-fg-2">{cancel}</span> : null}
      {failure ? (
        <span className="text-error-text">
          {failure.title}. {failure.body}
        </span>
      ) : null}
    </>
  );
}
