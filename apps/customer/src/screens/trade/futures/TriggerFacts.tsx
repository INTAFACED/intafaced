import type { Position } from '@intafaced/exchange-contract/schemas';
import type { StatusKind } from '@intafaced/ui';
import { fmtAmount, fmtPrice } from '../../../data/format';
import type { ConditionalOrder } from './api';
import { failedOutcome } from './protection-logic';
import { positionsCopy } from './positions-copy';
import { futuresRefusal } from './refusals';
import { triggersCopy } from './triggers-copy';

type T = ReturnType<typeof triggersCopy.useCopy>['t'];

const CANCEL_REASONS = ['replaced', 'position_closed', 'position_gone', 'cancelled', 'linked'] as const;
type CancelReason = (typeof CANCEL_REASONS)[number];
const isCancelReason = (reason: string): reason is CancelReason => (CANCEL_REASONS as readonly string[]).includes(reason);

/** Why a fired order failed, in words about the fired order rather than a request the trader can change. */
const FAILURES = {
  'trade.futures_reduce_only_exceeds_position': 'Failure covered',
  'trade.futures_engine_refused': 'Failure engine',
  'trade.conditional_order_cancelled': 'Failure limit gone',
  'trade.conditional_order_expired': 'Failure limit gone',
  'trade.conditional_order_rejected': 'Failure limit rejected',
  'trade.conditional_order_refused': 'Failure limit rejected',
  'trade.futures_reduce_past_bankruptcy': 'Failure past bankruptcy',
  'trade.conditional_field_required': 'Failure no limit',
} as const;
const isKnownFailure = (code: string): code is keyof typeof FAILURES => Object.hasOwn(FAILURES, code);

function failureWords(code: string | null, t: T): string {
  if (code !== null && isKnownFailure(code)) return t(FAILURES[code]);
  const refusal = futuresRefusal({ code: code ?? undefined });
  return `${t('Failure other')} ${refusal.title}. ${refusal.body}`;
}

/** What a failed order closed and where its position stands now, in one line. */
function outcomeWords(outcome: ReturnType<typeof failedOutcome>, t: T, side: (s: Position['side']) => string): string {
  const parts: string[] = [];
  if (outcome.closed !== null) parts.push(t('Outcome closed part', { qty: fmtAmount(outcome.closed, { places: 8 }) }));
  if (outcome.closeOrder !== null) parts.push(t('Outcome see order', { id: outcome.closeOrder }));
  if (outcome.closed === null && outcome.closeOrder === null) parts.push(t('Outcome nothing closed'));
  const position = outcome.position;
  if (position !== 'unknown') {
    if (position.state === 'open')
      parts.push(t('Outcome position open', { side: side(position.side), qty: fmtAmount(position.contracts, { places: 8 }) }));
    else parts.push(t(position.state === 'closing' ? 'Outcome position closing' : 'Outcome position gone'));
  }
  return parts.join(' ');
}

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

/**
 * The lines under an order's status: what a fired one closed and through which order, and why one stopped. A failed
 * one also says what it closed and where its position stands now, when `positions` (the open positions) is given;
 * null while they cannot be read.
 */
export function TriggerFacts({ order, positions }: { order: ConditionalOrder; positions?: readonly Position[] | null }) {
  const { t } = triggersCopy.useCopy();
  const sides = positionsCopy.useCopy().t;
  const cancel =
    order.status === 'cancelled' && order.cancelReason
      ? isCancelReason(order.cancelReason)
        ? t(`Cancel ${order.cancelReason}`)
        : t('Cancel other', { reason: order.cancelReason })
      : null;
  const failure = order.status === 'failed' ? failureWords(order.failureReason, t) : null;
  const outcome = order.status === 'failed' ? failedOutcome(order, positions ?? null) : null;
  return (
    <>
      {order.firedQuantity ? (
        <span className="text-fg-2">
          {order.status === 'failed'
            ? t('Fired failed', { qty: fmtAmount(order.firedQuantity, { places: 8 }) })
            : t('Fired', {
                qty: fmtAmount(order.firedQuantity, { places: 8 }),
                closed: fmtAmount(order.closedQuantity ?? '0', { places: 8 }),
              })}
        </span>
      ) : null}
      {order.closeOrderId ? <span className="text-2xs text-fg-3">{t('Close order', { id: order.closeOrderId })}</span> : null}
      {cancel ? <span className="text-fg-2">{cancel}</span> : null}
      {failure ? (
        <span className="text-error-text" data-failure={order.failureReason ?? ''}>
          {failure}
        </span>
      ) : null}
      {outcome ? (
        <span className="text-fg-2" data-outcome>
          {outcomeWords(outcome, t, (side) => sides(side === 'long' ? 'Side long' : 'Side short'))}
        </span>
      ) : null}
    </>
  );
}
