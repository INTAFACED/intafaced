import { useEffect, useState } from 'react';
import { PayDetails } from '../volt/parts';
import { ToggleChips } from '@intafaced/ui/lit';
import { StatusChip } from '@intafaced/ui/lit/templates';
import type { Trade } from '../schemas';
import { p2pDepth } from './p2p-depth-copy';
import { orderHistoryCopy } from './order-history-copy';
import { disputeStages, escrowView, timeLeft, type OrderAction, type OrderFilter, type StepId, type StepState } from './p2p-model';

/** The kit's step mark for a path state: filled when done, ringed when current, hollow otherwise (the words say which). */
function kitStep(state: StepState): 'done' | 'current' | 'todo' {
  return state === 'done' ? 'done' : state === 'current' ? 'current' : 'todo';
}

const ACTION_KEY = {
  markPaid: 'actionMarkPaid',
  release: 'actionRelease',
  cancel: 'actionCancel',
  dispute: 'actionDispute',
} as const satisfies Record<OrderAction, string>;

const STATUS_KEY = {
  created: 'statusCreated',
  escrowed: 'statusEscrowed',
  fiat_sent: 'statusFiatSent',
  released: 'statusReleased',
  cancelled: 'statusCancelled',
  disputed: 'statusDisputed',
} as const satisfies Record<Trade['status'], string>;

/** An order's status in words a person uses, never the machine value. */
/** An order's state; with the server's readable status (`trades.get`), in the order list's own words. */
export function TradeStatus({ status, display }: { status: Trade['status']; display?: Trade['displayStatus'] }) {
  const { t } = p2pDepth.useCopy();
  const list = orderHistoryCopy.useCopy();
  return (
    <StatusChip
      status={status === 'cancelled' ? 'failed' : status === 'released' ? 'done' : status === 'disputed' ? 'pending' : 'unknown'}
      label={display ? list.t(display) : t(STATUS_KEY[status])}
    />
  );
}

/** The escrow path of one order: where it is, whose turn it is, what can be done now, and the deadline. */
export function EscrowPath({ trade, userId }: { trade: Trade; userId: string | null }) {
  const { t, languageFor, directionFor } = p2pDepth.useCopy();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const view = escrowView(trade, userId);
  const closedLabel =
    view.outcome === 'released'
      ? t('closedReleased')
      : view.outcome === 'returned'
        ? t('closedReturned')
        : view.outcome === 'voided'
          ? t('closedVoided')
          : view.outcome === 'disputed'
            ? t('closedDisputed')
            : view.outcome === 'cancelled'
              ? t('closedCancelled')
              : t('stepClosed');
  const stepNow = (id: StepId) => view.steps.find((step) => step.id === id)?.state === 'current';
  // The step in progress says what is being waited for, not the name of a step that has not happened.
  const labels: Record<StepId, string> = {
    created: t('stepCreated'),
    escrowed: t('stepEscrowed'),
    fiat_sent:
      stepNow('fiat_sent') && view.outcome === 'open'
        ? view.role === 'buyer'
          ? t('stepWaitPaidYou')
          : t('stepWaitPaid')
        : t('stepFiatSent'),
    closed:
      stepNow('closed') && view.outcome === 'open'
        ? view.role === 'seller'
          ? t('stepWaitReleaseYou')
          : t('stepWaitRelease')
        : closedLabel,
  };
  const stateLabel = (state: StepState) =>
    state === 'done' ? t('stateDone') : state === 'current' ? t('stateCurrent') : state === 'unknown' ? t('stateUnknown') : '';
  const turn =
    view.waitingOn === 'you'
      ? t('waitYou')
      : view.waitingOn === 'counterparty'
        ? t('waitCounterparty')
        : view.waitingOn === 'service'
          ? t('waitService')
          : view.waitingOn === 'moderator'
            ? t('waitModerator')
            : t('waitNobody');
  const left = timeLeft(trade.deadlineAt, now);
  const closed = view.outcome !== 'open' && view.outcome !== 'disputed';
  return (
    <section aria-label={t('escrowTitle')} lang={languageFor('escrowTitle')} dir={directionFor('escrowTitle')} data-testid="escrow-path">
      <h3>{t('escrowTitle')}</h3>
      <ol className="lt-steps">
        {view.steps.map((step) => (
          <li
            key={step.id}
            className="lt-step"
            data-step={kitStep(step.state)}
            data-state={step.state}
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <span className="lt-step-dot" aria-hidden="true" />
            <span>{labels[step.id]}</span>
            <span className="lt-step-at">{stateLabel(step.state)}</span>
          </li>
        ))}
      </ol>
      <p>
        <strong data-testid="escrow-turn">{turn}</strong>
      </p>
      {view.actions.length > 0 ? (
        <>
          <p className="lt-hint">{t('canNow')}</p>
          <ul>
            {view.actions.map((action) => (
              <li key={action}>{t(ACTION_KEY[action])}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="lt-hint">{t('noActions')}</p>
      )}
      {!closed ? (
        <PayDetails
          values={[
            [
              t('deadline'),
              left.kind === 'none'
                ? t('deadlineNone')
                : left.kind === 'left'
                  ? t('deadlineLeft', { hours: left.hours, minutes: left.minutes })
                  : t('deadlinePast', { hours: left.hours, minutes: left.minutes }),
            ],
          ]}
        />
      ) : null}
      {!closed && left.kind === 'past' ? <p className="lt-hint">{t('deadlinePastHint')}</p> : null}
    </section>
  );
}

/** Four stages of a dispute from what the service reports. */
export function DisputeProgress({
  dispute,
}: {
  dispute: {
    status: 'open' | 'resolved';
    evidence: readonly unknown[];
    moderatorId: string | null;
    lastSeenByModeratorAt: string | null;
    overdue: boolean;
  };
}) {
  const { t } = p2pDepth.useCopy();
  const labels = { opened: t('stageOpened'), evidence: t('stageEvidence'), review: t('stageReview'), ruled: t('stageRuled') } as const;
  return (
    <div data-testid="dispute-progress">
      <h3>{t('disputeProgress')}</h3>
      <ol className="lt-steps">
        {disputeStages(dispute).map((stage) => (
          <li
            key={stage.id}
            className="lt-step"
            data-step={kitStep(stage.state)}
            data-state={stage.state}
            aria-current={stage.state === 'current' ? 'step' : undefined}
          >
            <span className="lt-step-dot" aria-hidden="true" />
            <span>{labels[stage.id]}</span>
            <span className="lt-step-at">
              {stage.state === 'done' ? t('stateDone') : stage.state === 'current' ? t('stateCurrent') : ''}
            </span>
          </li>
        ))}
      </ol>
      {dispute.overdue && dispute.status === 'open' ? <p className="lt-hint">{t('disputeOverdue')}</p> : null}
    </div>
  );
}

/** Buy / sell / all and payment method for the offer board. */
export function OfferTabs({ side, onSide }: { side: '' | 'buy' | 'sell'; onSide: (side: '' | 'buy' | 'sell') => void }) {
  const { t } = p2pDepth.useCopy();
  // The taker's wish is the opposite of the maker's side: a person who wants to buy takes offers where the maker sells.
  const tabs: [string, '' | 'buy' | 'sell'][] = [
    [t('tabAllOffers'), ''],
    [t('tabBuy'), 'sell'],
    [t('tabSell'), 'buy'],
  ];
  return (
    <ToggleChips
      label={t('tabAllOffers')}
      options={tabs.map(([label, value]) => ({ value, label }))}
      value={side}
      onChange={(next) => next !== null && onSide(next)}
    />
  );
}

export function OrderFilterTabs({
  value,
  counts,
  onChange,
  note,
}: {
  value: OrderFilter;
  counts: Record<OrderFilter, number>;
  onChange: (value: OrderFilter) => void;
  /** What the counts cover, when not only the orders loaded on the page. */
  note?: string;
}) {
  const { t } = p2pDepth.useCopy();
  const tabs: [string, OrderFilter][] = [
    [t('ordersAll'), 'all'],
    [t('ordersActive'), 'active'],
    [t('ordersDisputed'), 'disputed'],
    [t('ordersCompleted'), 'completed'],
    [t('ordersCancelled'), 'cancelled'],
  ];
  return (
    <>
      <div data-testid="order-filters">
        <ToggleChips
          label={t('ordersFilterLabel')}
          options={tabs.map(([label, key]) => ({ value: key, label: `${label} (${counts[key]})` }))}
          value={value}
          onChange={(next) => next !== null && onChange(next)}
        />
      </div>
      <p className="lt-hint">{note ?? t('ordersCountsNote')}</p>
    </>
  );
}

export { TakeOfferPanel } from './TakeOffer';
