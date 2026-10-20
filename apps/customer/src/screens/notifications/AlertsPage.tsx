import { useId, useRef, useState } from 'react';
import './notifications.css';
import { useSession } from '../../features/session/session';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import { submitCancel, submitCreate } from './alerts-actions';
import { alertsCopy } from './alerts-copy';
import {
  createGate,
  evaluationNote,
  findDuplicate,
  expiryIso,
  expiryProblem,
  priceProblem,
  settleUnknownCreate,
  type CancelWords,
  type Refusal,
} from './alerts-model';
import { Button, StateBlock } from './deps';
import { ALERT_CONDITIONS, directionOfCondition, listAlerts, type AlertCondition, type AlertIntent, type PriceAlert } from './notify-api';
import { NotifyNav } from './NotifyNav';
import { useAlertMarkets, useAlerts, type AlertMarket } from './use-alerts';

type Notice =
  | { kind: 'saved'; found: boolean }
  | { kind: 'cancelled'; words: CancelWords }
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'cancelUnsure' };
type Unsure = {
  intent: AlertIntent;
  before: ReadonlySet<string>;
  phase: 'checking' | 'absent' | 'checkFailed';
};

const REFUSAL = {
  signedOut: 'refusedSignedOut',
  notAllowed: 'refusedNotAllowed',
  notOn: 'refusedNotOn',
  priceMissing: 'refusedPriceMissing',
  badRequest: 'refusedBadRequest',
  textRejected: 'refusedTextRejected',
  expiryRejected: 'refusedExpiryRejected',
  optionNotOn: 'refusedOptionNotOn',
  tooMany: 'refusedTooMany',
  accountChanged: 'refusedAccountChanged',
  unpublished: 'refusedUnpublished',
  other: 'refusedOther',
} as const satisfies Record<Refusal, string>;
const CANCEL = {
  cancelled: 'cancelDone',
  alreadyFired: 'cancelAlreadyFired',
  alreadyCancelled: 'cancelAlreadyCancelled',
  notFound: 'cancelNotFound',
} as const satisfies Record<CancelWords, string>;
const STATUS = { active: 'statusActive', fired: 'statusFired', cancelled: 'statusCancelled', expired: 'statusExpired' } as const;
const CONDITION_KEY = {
  greater_than: 'above',
  less_than: 'below',
  crossing_up: 'crossingUp',
  crossing_down: 'crossingDown',
  crossing: 'crossing',
} as const satisfies Record<AlertCondition, string>;
const KIND = { funding: 'kindFunding', liquidation_proximity: 'kindLiquidation', whale: 'kindWhale' } as const;
/** Refusals that mean the typed values need changing, so the person goes back to the form. */
const BACK_TO_FORM: ReadonlySet<Refusal> = new Set(['priceMissing', 'badRequest', 'textRejected', 'expiryRejected']);

/**
 * Price alerts (`/notifications?view=alerts`): the person's alerts with their status, a form to add one that is reviewed
 * before it is saved, and a confirmed cancel. Neither change takes a request id, so one that is not answered is never shown as
 * failed or done: the list is checked and the person decides.
 */
export default function AlertsPage() {
  const copy = alertsCopy.useCopy();
  const { api, userId, mode } = useSession();
  const { timeZone } = usePreferences();
  const id = useId();
  const { state, reload } = useAlerts();
  const markets = useAlertMarkets();
  const [marketId, setMarketId] = useState('');
  const [condition, setCondition] = useState<AlertCondition>('greater_than');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [expires, setExpires] = useState('');
  const [price, setPrice] = useState('');
  const [touched, setTouched] = useState(false);
  const [review, setReview] = useState<{ intent: AlertIntent; duplicate: boolean } | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<'create' | string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [unsure, setUnsure] = useState<Unsure | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  // One change at a time, even if a click lands twice before the screen redraws.
  const gate = useRef(createGate());

  const list = state.status === 'ready' ? state : null;
  const marketList: AlertMarket[] = markets.status === 'ready' ? markets.markets : [];
  const marketOf = (value: string) => marketList.find((market) => market.id === value);
  const selected = marketOf(marketId);
  const problem = touched ? priceProblem(price) : null;

  const blockedReason: Parameters<typeof copy.t>[0] | null =
    busy !== null
      ? 'reasonBusy'
      : unsure
        ? 'reasonUnsure'
        : markets.status === 'loading'
          ? 'reasonMarketsLoading'
          : markets.status === 'failed'
            ? 'reasonMarketsFailed'
            : marketList.length === 0
              ? 'reasonNoMarkets'
              : state.status === 'loading'
                ? 'reasonListLoading'
                : state.status === 'failed'
                  ? 'reasonListFailed'
                  : null;

  if (mode !== 'Personal') {
    return (
      <div className="if-notify">
        <div className="nf-head">
          <h1 className="nf-h1">{copy.t('title')}</h1>
        </div>
        <NotifyNav current="alerts" />
        <p className="nf-note" role="note">
          {copy.t('businessNote')}
        </p>
      </div>
    );
  }

  function toReview() {
    setTouched(true);
    setNotice(null);
    if (blockedReason || !marketId || priceProblem(price) !== null || expiryProblem(expires) !== null || !list) return;
    const expiresAt = expiryIso(expires);
    const intent: AlertIntent = {
      marketId,
      direction: directionOfCondition(condition),
      condition,
      targetPrice: price.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(message.trim() ? { message: message.trim() } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    setAck(false);
    setReview({ intent, duplicate: findDuplicate(list.items, intent) !== null });
  }

  async function check(pending: Unsure) {
    setUnsure({ ...pending, phase: 'checking' });
    const result = await listAlerts(api);
    reload();
    if (!result.ok) return setUnsure({ ...pending, phase: 'checkFailed' });
    const mine = result.data.items.filter((row) => row.userId === userId);
    if (settleUnknownCreate(pending.before, pending.intent, mine)) {
      setUnsure(null);
      setNotice({ kind: 'saved', found: true });
    } else setUnsure({ ...pending, phase: 'absent' });
  }

  async function confirmSave() {
    if (!review || !userId || busy !== null || unsure) return;
    if (list && !list.evaluation.canFire && !ack) return;
    if (!gate.current.enter()) return;
    setBusy('create');
    setNotice(null);
    const { intent } = review;
    const before = new Set(list ? list.items.map((row) => row.id) : []);
    try {
      const outcome = await submitCreate(api, intent, userId);
      if (outcome.kind === 'saved') {
        setNotice({ kind: 'saved', found: false });
        setReview(null);
        setPrice('');
        setName('');
        setMessage('');
        setExpires('');
        setTouched(false);
        reload();
      } else if (outcome.kind === 'refused') {
        setNotice({ kind: 'refused', refusal: outcome.refusal });
        if (BACK_TO_FORM.has(outcome.refusal)) setReview(null);
      } else {
        setReview(null);
        void check({ intent, before, phase: 'checking' });
      }
    } finally {
      gate.current.leave();
      setBusy(null);
    }
  }

  async function confirmCancel(alert: PriceAlert) {
    if (!userId || busy !== null || unsure) return;
    if (!gate.current.enter()) return;
    setBusy(alert.id);
    setNotice(null);
    try {
      const outcome = await submitCancel(api, alert.id, userId);
      setAsking(null);
      if (outcome.kind === 'done') setNotice({ kind: 'cancelled', words: outcome.words });
      else if (outcome.kind === 'refused') setNotice({ kind: 'refused', refusal: outcome.refusal });
      else setNotice({ kind: 'cancelUnsure' });
      if (outcome.kind !== 'refused') reload();
    } finally {
      gate.current.leave();
      setBusy(null);
    }
  }

  const conditionWords = (value: AlertCondition) => copy.t(CONDITION_KEY[value]);
  const evaluation = list?.evaluation ?? null;
  const priceId = `${id}-price`;

  return (
    <div className="if-notify">
      <div className="nf-head">
        <h1 className="nf-h1">{copy.t('title')}</h1>
      </div>
      <NotifyNav current="alerts" />
      <p className="nf-intro">{copy.t('intro')}</p>
      {evaluation ? (
        <p className={`nf-banner${evaluation.canFire ? ' nf-banner--ok' : ''}`} role="note" data-testid="alerts-evaluation">
          {copy.t(evaluationNote(evaluation))}
        </p>
      ) : null}

      <div aria-live="polite" data-testid="alerts-notices">
        {notice?.kind === 'saved' ? (
          <p className="nf-banner nf-banner--ok" role="status">
            {copy.t(notice.found ? 'savedFound' : 'saved')}
          </p>
        ) : notice?.kind === 'cancelled' ? (
          <p className="nf-banner nf-banner--ok" role="status">
            {copy.t(CANCEL[notice.words])}
          </p>
        ) : notice?.kind === 'refused' ? (
          <p className="nf-banner nf-banner--bad" role="alert">
            {copy.t(REFUSAL[notice.refusal])}
          </p>
        ) : notice?.kind === 'cancelUnsure' ? (
          <div className="nf-banner nf-banner--warn" role="status">
            <strong>{copy.t('cancelUnsureTitle')}</strong>
            <p>{copy.t('cancelUnsureBody')}</p>
          </div>
        ) : null}
        {unsure ? (
          <div className="nf-banner nf-banner--warn" role="status" data-testid="alerts-unsure">
            <strong>{copy.t('unsureTitle')}</strong>
            <p>{copy.t('unsureBody')}</p>
            {unsure.phase === 'checking' ? <p className="nf-muted">{copy.t('unsureChecking')}</p> : null}
            {unsure.phase === 'absent' ? <p>{copy.t('unsureAbsent')}</p> : null}
            {unsure.phase === 'checkFailed' ? <p>{copy.t('unsureCheckFailed')}</p> : null}
            <div className="nf-address__actions">
              {unsure.phase === 'checkFailed' ? (
                <Button size={32} onClick={() => void check(unsure)}>
                  {copy.t('unsureCheckAgain')}
                </Button>
              ) : null}
              {unsure.phase === 'absent' ? (
                <>
                  <Button
                    size={32}
                    onClick={() => {
                      // The first create may still land after the re-check, so warn again from the latest list.
                      setReview({ intent: unsure.intent, duplicate: list ? findDuplicate(list.items, unsure.intent) !== null : false });
                      setAck(false);
                      setUnsure(null);
                    }}
                  >
                    {copy.t('unsureSaveAgain')}
                  </Button>
                  <Button variant="ghost" size={32} onClick={() => setUnsure(null)}>
                    {copy.t('unsureDismiss')}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {review ? (
        <section className="nf-card nf-alertform" aria-labelledby={`${id}-review`} data-testid="alerts-review">
          <h2 className="nf-h2" id={`${id}-review`}>
            {copy.t('reviewTitle')}
          </h2>
          <dl className="nf-facts">
            <div>
              <dt>{copy.t('reviewMarket')}</dt>
              <dd>{marketOf(review.intent.marketId)?.label ?? copy.t('unlistedMarket')}</dd>
            </div>
            <div>
              <dt>{copy.t('reviewWhen')}</dt>
              <dd>{conditionWords(review.intent.condition ?? (review.intent.direction === 'below' ? 'less_than' : 'greater_than'))}</dd>
            </div>
            {review.intent.name ? (
              <div>
                <dt>{copy.t('reviewName')}</dt>
                <dd>{review.intent.name}</dd>
              </div>
            ) : null}
            {review.intent.message ? (
              <div>
                <dt>{copy.t('reviewMessage')}</dt>
                <dd>{review.intent.message}</dd>
              </div>
            ) : null}
            {review.intent.expiresAt ? (
              <div>
                <dt>{copy.t('reviewExpires')}</dt>
                <dd>{stamp(review.intent.expiresAt, timeZone)}</dd>
              </div>
            ) : null}
            <div>
              <dt>{copy.t('reviewPrice')}</dt>
              <dd lang="zxx" className="nf-num">
                {review.intent.targetPrice} {marketOf(review.intent.marketId)?.quote ?? ''}
              </dd>
            </div>
          </dl>
          <p className="nf-muted">{copy.t('reviewOnce')}</p>
          {evaluation ? <p className="nf-muted">{copy.t(evaluationNote(evaluation))}</p> : null}
          {review.duplicate ? (
            <p className="nf-banner nf-banner--warn" role="note">
              {copy.t('reviewDuplicate')}
            </p>
          ) : null}
          {evaluation && !evaluation.canFire ? (
            <label className="nf-check">
              <input type="checkbox" checked={ack} disabled={busy !== null} onChange={(event) => setAck(event.target.checked)} />
              <span>{copy.t('reviewAck')}</span>
            </label>
          ) : null}
          <div className="nf-address__actions">
            <Button variant="secondary" size={32} disabled={busy !== null} onClick={() => setReview(null)}>
              {copy.t('back')}
            </Button>
            <Button
              size={32}
              loading={busy === 'create'}
              disabled={busy !== null || (evaluation !== null && !evaluation.canFire && !ack)}
              onClick={() => void confirmSave()}
            >
              {copy.t(busy === 'create' ? 'saving' : 'save')}
            </Button>
          </div>
        </section>
      ) : (
        <form
          className="nf-card nf-alertform"
          noValidate
          aria-labelledby={`${id}-new`}
          data-testid="alerts-form"
          onSubmit={(event) => {
            event.preventDefault();
            toReview();
          }}
        >
          <h2 className="nf-h2" id={`${id}-new`}>
            {copy.t('newTitle')}
          </h2>
          <label className="nf-field">
            <span>{copy.t('marketLabel')}</span>
            <select value={marketId} disabled={blockedReason !== null} onChange={(event) => setMarketId(event.target.value)}>
              <option value="">{copy.t('marketPlaceholder')}</option>
              {marketList.map((market) => (
                <option key={market.id} value={market.id}>
                  {market.label}
                </option>
              ))}
            </select>
          </label>
          <label className="nf-field">
            <span>{copy.t('conditionLabel')}</span>
            <select
              value={condition}
              disabled={blockedReason !== null}
              onChange={(event) => setCondition(ALERT_CONDITIONS.find((c) => c === event.target.value) ?? 'greater_than')}
            >
              {ALERT_CONDITIONS.map((value) => (
                <option key={value} value={value}>
                  {conditionWords(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="nf-field" htmlFor={priceId}>
            <span>{selected ? copy.t('priceLabel', { quote: selected.quote }) : copy.t('priceLabelNoMarket')}</span>
            <input
              id={priceId}
              inputMode="decimal"
              autoComplete="off"
              maxLength={64}
              value={price}
              disabled={blockedReason !== null}
              aria-invalid={problem !== null}
              aria-describedby={`${priceId}-help`}
              onChange={(event) => {
                setPrice(event.target.value);
                setTouched(false);
              }}
            />
            <small id={`${priceId}-help`} className={problem ? 'nf-error' : 'nf-muted'}>
              {problem === 'empty' ? copy.t('priceEmpty') : problem === 'invalid' ? copy.t('priceInvalid') : copy.t('priceHint')}
            </small>
          </label>
          <label className="nf-field">
            <span>{copy.t('nameLabel')}</span>
            <input autoComplete="off" value={name} disabled={blockedReason !== null} onChange={(event) => setName(event.target.value)} />
            <small className="nf-muted">{copy.t('nameHint')}</small>
          </label>
          <label className="nf-field">
            <span>{copy.t('messageLabel')}</span>
            <input
              autoComplete="off"
              value={message}
              disabled={blockedReason !== null}
              onChange={(event) => setMessage(event.target.value)}
            />
            <small className="nf-muted">
              {copy.t('messageHint', { market: '{market}', price: '{price}', condition: '{condition}', time: '{time}' })}
            </small>
          </label>
          <label className="nf-field">
            <span>{copy.t('expiresLabel')}</span>
            <input
              type="datetime-local"
              value={expires}
              disabled={blockedReason !== null}
              aria-invalid={expiryProblem(expires) !== null}
              onChange={(event) => setExpires(event.target.value)}
            />
            <small className={expiryProblem(expires) ? 'nf-error' : 'nf-muted'}>
              {expiryProblem(expires) ? copy.t('expiresInvalid') : copy.t('expiresHint')}
            </small>
          </label>
          <div className="nf-address__actions">
            <Button type="submit" size={32} disabled={blockedReason !== null}>
              {copy.t('review')}
            </Button>
          </div>
          {blockedReason ? (
            <p className="nf-muted" data-testid="alerts-reason">
              {copy.t(blockedReason)}
            </p>
          ) : null}
        </form>
      )}

      <section className="nf-card" aria-label={copy.t('listLabel')} aria-busy={state.status === 'loading' || undefined}>
        <div className="nf-listhead">
          <h2 className="nf-h2 nf-h2--flush">{copy.t('listTitle')}</h2>
          <button type="button" className="nf-link nf-linkbutton" disabled={busy !== null} onClick={reload}>
            {copy.t('refresh')}
          </button>
        </div>
        {state.status === 'loading' ? (
          <StateBlock kind="loading" rows={3} rowHeight={72} label={copy.t('loadingList')} className="nf-card__loading" />
        ) : state.status === 'failed' ? (
          <StateBlock kind="error" title={copy.t('listFailed')} onRetry={reload} retryLabel={copy.t('retry')} />
        ) : state.items.length === 0 ? (
          <StateBlock kind="empty" title={copy.t('emptyTitle')} body={copy.t('emptyBody')} />
        ) : (
          <ul className="nf-list" data-testid="alerts-list">
            {state.items.map((alert) => {
              const market = marketOf(alert.marketId);
              const name = market?.label ?? copy.t('unlistedMarket');
              const kind = alert.kind === 'price' ? null : copy.t(KIND[alert.kind]);
              return (
                <li key={alert.id} className="nf-alertrow" data-testid="alert-row" data-status={alert.status}>
                  <div className="nf-text">
                    <span className="nf-title">{alert.name ? alert.name : kind ? `${name} · ${kind}` : name}</span>
                    <span className="nf-body nf-body--wrap">
                      {copy.t('condition', {
                        side: conditionWords(alert.condition ?? (alert.direction === 'below' ? 'less_than' : 'greater_than')),
                        price: alert.targetPrice,
                      }) + (alert.kind === 'price' && market ? ` ${market.quote}` : '')}
                    </span>
                    {alert.message ? <span className="nf-body nf-body--wrap">{alert.message}</span> : null}
                    <span className="nf-muted">
                      {copy.t('created', { when: stamp(alert.createdAt, timeZone) }) +
                        (alert.firedAt ? ` · ${copy.t('firedAt', { when: stamp(alert.firedAt, timeZone) })}` : '') +
                        (alert.expiresAt
                          ? ` · ${copy.t(alert.status === 'expired' ? 'expiredAt' : 'expiresAt', { when: stamp(alert.expiresAt, timeZone) })}`
                          : '')}
                    </span>
                  </div>
                  <div className="nf-alertside">
                    <span className={`nf-pill${alert.status === 'active' ? ' nf-pill--ok' : ''}`}>{copy.t(STATUS[alert.status])}</span>
                    {alert.status === 'active' && asking !== alert.id ? (
                      <Button
                        variant="ghost"
                        size={28}
                        disabled={busy !== null || unsure !== null}
                        aria-label={copy.t('cancelAria', { market: name })}
                        onClick={() => setAsking(alert.id)}
                      >
                        {copy.t('cancelAlert')}
                      </Button>
                    ) : null}
                  </div>
                  {asking === alert.id ? (
                    <div className="nf-alertask" role="group" aria-label={copy.t('cancelAsk')}>
                      <p>{copy.t('cancelAsk')}</p>
                      <div className="nf-address__actions">
                        <Button variant="secondary" size={32} disabled={busy !== null} onClick={() => setAsking(null)}>
                          {copy.t('cancelKeep')}
                        </Button>
                        <Button size={32} loading={busy === alert.id} disabled={busy !== null} onClick={() => void confirmCancel(alert)}>
                          {copy.t(busy === alert.id ? 'cancelling' : 'cancelConfirm')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <p className="nf-note">{copy.t('listBoundary')}</p>
    </div>
  );
}
