import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../../shared/ui';
import { displayAmount } from '../../../shared/money';
import { PayDetails, PaySection } from '../components';
import type { Offer, Trade } from '../schemas';
import { p2pDepth } from './p2p-depth-copy';
import {
  checkTake,
  disputeStages,
  escrowView,
  offerMethodIds,
  timeLeft,
  type OrderAction,
  type OrderFilter,
  type StepId,
  type StepState,
} from './p2p-model';
import './p2p-depth.css';

/** A plain, always-visible reason. Used where a control exists but the service behind it does not. */
export function P2PReason({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="p2p-reason" role="note" aria-label={title}>
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  );
}

const ACTION_KEY = {
  markPaid: 'actionMarkPaid',
  release: 'actionRelease',
  cancel: 'actionCancel',
  dispute: 'actionDispute',
} as const satisfies Record<OrderAction, string>;

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
  const labels: Record<StepId, string> = {
    created: t('stepCreated'),
    escrowed: t('stepEscrowed'),
    fiat_sent: t('stepFiatSent'),
    closed: closedLabel,
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
    <section
      className="p2p-path"
      aria-label={t('escrowTitle')}
      lang={languageFor('escrowTitle')}
      dir={directionFor('escrowTitle')}
      data-testid="escrow-path"
    >
      <h3>{t('escrowTitle')}</h3>
      <ol className="p2p-path-steps">
        {view.steps.map((step) => (
          <li key={step.id} data-state={step.state} aria-current={step.state === 'current' ? 'step' : undefined}>
            <span className="p2p-path-dot" aria-hidden="true" />
            <span>{labels[step.id]}</span>
            <span className="p2p-path-state">{stateLabel(step.state)}</span>
          </li>
        ))}
      </ol>
      <p className="p2p-path-turn">
        <strong data-testid="escrow-turn">{turn}</strong>
      </p>
      {view.actions.length > 0 ? (
        <>
          <p className="muted">{t('canNow')}</p>
          <ul className="p2p-path-actions">
            {view.actions.map((action) => (
              <li key={action}>{t(ACTION_KEY[action])}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">{t('noActions')}</p>
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
      {!closed && left.kind === 'past' ? <p className="muted">{t('deadlinePastHint')}</p> : null}
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
    <div className="p2p-path" data-testid="dispute-progress">
      <h3>{t('disputeProgress')}</h3>
      <ol className="p2p-path-steps">
        {disputeStages(dispute).map((stage) => (
          <li key={stage.id} data-state={stage.state} aria-current={stage.state === 'current' ? 'step' : undefined}>
            <span className="p2p-path-dot" aria-hidden="true" />
            <span>{labels[stage.id]}</span>
            <span className="p2p-path-state">
              {stage.state === 'done' ? t('stateDone') : stage.state === 'current' ? t('stateCurrent') : ''}
            </span>
          </li>
        ))}
      </ol>
      {dispute.overdue && dispute.status === 'open' ? <p className="muted">{t('disputeOverdue')}</p> : null}
    </div>
  );
}

/** The order conversation. Every control is shown; none can send, because no chat service is connected. */
export function OrderChat() {
  const { t } = p2pDepth.useCopy();
  return (
    <PaySection title={t('chatLabel')}>
      <div className="p2p-chat" data-testid="order-chat">
        <P2PReason title={t('chatReasonTitle')}>{t('chatReasonBody')}</P2PReason>
        <div className="p2p-chat-thread" role="log" aria-label={t('chatLabel')}>
          {t('chatEmpty')}
        </div>
        <form className="p2p-chat-compose" onSubmit={(event) => event.preventDefault()}>
          <fieldset disabled style={{ display: 'contents' }}>
            <label className="field" style={{ flex: 1 }}>
              <span>{t('chatLabel')}</span>
              <textarea placeholder={t('chatPlaceholder')} rows={2} />
            </label>
            <Button type="submit" variant="primary" disabled>
              {t('chatSend')}
            </Button>
          </fieldset>
        </form>
        <p className="muted">{t('chatSendOff')}</p>
      </div>
    </PaySection>
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
    <div className="p2p-seg" role="group" aria-label={t('tabAllOffers')}>
      {tabs.map(([label, value]) => (
        <button key={label} type="button" aria-pressed={side === value} onClick={() => onSide(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function OrderFilterTabs({
  value,
  counts,
  onChange,
}: {
  value: OrderFilter;
  counts: Record<OrderFilter, number>;
  onChange: (value: OrderFilter) => void;
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
      <div className="p2p-seg" role="group" aria-label={t('ordersFilterLabel')} data-testid="order-filters">
        {tabs.map(([label, key]) => (
          <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}>
            {`${label} (${counts[key]})`}
          </button>
        ))}
      </div>
      <p className="muted">{t('ordersCountsNote')}</p>
    </>
  );
}

/**
 * Placing an order on someone else's offer. The quantity is checked against the offer's limits and the external
 * payment is shown exactly (price × quantity). The order itself stays off: the service returns no fee or reservation
 * preview, and an order locks money in escrow, so it is not placed blind.
 */
export function TakeOfferPanel({ offer }: { offer: Offer }) {
  const { t, languageFor, directionFor } = p2pDepth.useCopy();
  const methods = offerMethodIds(offer);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('');
  const check = checkTake(offer, amount);
  const problem =
    check.kind === 'empty'
      ? t('takeNeedAmount')
      : check.kind === 'invalid'
        ? t('takeInvalid')
        : check.kind === 'belowMin'
          ? t('takeBelowMin')
          : check.kind === 'aboveMax'
            ? t('takeAboveMax')
            : check.kind === 'aboveRemaining'
              ? t('takeAboveRemaining')
              : null;
  return (
    <section
      className="p2p-take"
      aria-label={t('takeTitle')}
      lang={languageFor('takeTitle')}
      dir={directionFor('takeTitle')}
      data-testid="take-offer"
    >
      <h3>{t('takeTitle')}</h3>
      <form onSubmit={(event) => event.preventDefault()} className="form-stack" noValidate>
        <label className="field">
          <span>{t('takeAmount', { asset: offer.asset })}</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={problem !== null && check.kind !== 'empty'}
          />
          {problem && check.kind !== 'empty' ? <small className="error-text">{problem}</small> : null}
        </label>
        <label className="field">
          <span>{t('takeMethod')}</span>
          <select value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="">{methods.length ? '—' : t('takeNoMethods')}</option>
            {methods.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <PayDetails
          values={[
            [
              t('takeTotal'),
              check.kind === 'ok'
                ? check.fiatTotal === null
                  ? t('takeFloat')
                  : `${displayAmount(check.fiatTotal)} ${offer.fiatCurrency}`
                : '—',
            ],
          ]}
        />
        <Button type="submit" variant="primary" disabled data-testid="take-review">
          {t('takeReview')}
        </Button>
      </form>
      <P2PReason title={t('takeOffTitle')}>{t('takeOffBody')}</P2PReason>
    </section>
  );
}
