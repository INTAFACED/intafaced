import { useId, useRef, useState } from 'react';
import './notifications.css';
import { useSession } from '../../features/session/session';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import { submitActive, submitCancel, submitCreate, submitDelete, submitEdit, submitWatchlist } from './alerts-actions';
import { alertsCopy } from './alerts-copy';
import {
  canEdit,
  createGate,
  DEFAULT_VIEW,
  evaluationNote,
  findDuplicate,
  expiryIso,
  expiryProblem,
  priceProblem,
  settleUnknownCreate,
  visibleAlerts,
  type ActiveWords,
  type AlertSort,
  type AlertStatusFilter,
  type AlertView,
  type CancelWords,
  type Refusal,
} from './alerts-model';
import { AlertEditPanel } from './AlertEditPanel';
import { TriggerLog } from './TriggerLog';
import { WatchlistAlert, type BlockedReason } from './WatchlistAlert';
import { useAlertQuota } from './use-quota';
import { useTriggers } from './use-triggers';
import { Button, StateBlock } from './deps';
import {
  ALERT_CONDITIONS,
  directionOfCondition,
  isCrossing,
  listAlerts,
  type AlertCondition,
  type AlertExtra,
  type AlertIntent,
  type PriceAlert,
  type WatchlistIntent,
} from './notify-api';
import { NotifyNav } from './NotifyNav';
import { useAlertMarkets, useAlerts, type AlertMarket } from './use-alerts';

type Notice =
  | { kind: 'saved'; found: boolean }
  | { kind: 'cancelled'; words: CancelWords }
  | { kind: 'active'; words: ActiveWords }
  | { kind: 'edited' }
  | { kind: 'watchlistSaved' }
  | { kind: 'deleted'; gone: boolean }
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'cancelUnsure' }
  | { kind: 'changeUnsure'; what: 'active' | 'edit' | 'delete' | 'watchlist' };
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
  tooManyConditions: 'refusedTooManyConditions',
  repeatOff: 'refusedRepeatOff',
  repeatRejected: 'refusedRepeatRejected',
  optionNotOn: 'refusedOptionNotOn',
  tooMany: 'refusedTooMany',
  accountChanged: 'refusedAccountChanged',
  unpublished: 'refusedUnpublished',
  notEditable: 'refusedNotEditable',
  quotaOff: 'refusedQuotaOff',
  quotaReached: 'refusedQuotaReached',
  notFound: 'refusedNotFound',
  logOff: 'refusedLogOff',
  other: 'refusedOther',
} as const satisfies Record<Refusal, string>;
const CANCEL = {
  cancelled: 'cancelDone',
  alreadyFired: 'cancelAlreadyFired',
  alreadyCancelled: 'cancelAlreadyCancelled',
  notFound: 'cancelNotFound',
} as const satisfies Record<CancelWords, string>;
const ACTIVE = {
  paused: 'pausedDone',
  resumed: 'resumedDone',
  expired: 'activeExpired',
  alreadyFired: 'activeFired',
  alreadyCancelled: 'activeCancelled',
} as const satisfies Record<ActiveWords, string>;
const UNSURE = {
  active: ['activeUnsureTitle', 'activeUnsureBody'],
  edit: ['editUnsureTitle', 'editUnsureBody'],
  delete: ['deleteUnsureTitle', 'deleteUnsureBody'],
  watchlist: ['watchUnsureTitle', 'watchUnsureBody'],
} as const;
const STATUS = {
  active: 'statusActive',
  fired: 'statusFired',
  cancelled: 'statusCancelled',
  expired: 'statusExpired',
  stopped: 'statusStopped',
} as const;
const CONDITION_KEY = {
  greater_than: 'above',
  less_than: 'below',
  crossing_up: 'crossingUp',
  crossing_down: 'crossingDown',
  crossing: 'crossing',
} as const satisfies Record<AlertCondition, string>;
const KIND = { funding: 'kindFunding', liquidation_proximity: 'kindLiquidation', whale: 'kindWhale' } as const;
/** Refusals that mean the typed values need changing, so the person goes back to the form. */
const BACK_TO_FORM: ReadonlySet<Refusal> = new Set([
  'priceMissing',
  'badRequest',
  'textRejected',
  'expiryRejected',
  'tooManyConditions',
  'repeatOff',
  'repeatRejected',
]);

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
  const [repeat, setRepeat] = useState(false);
  const [extras, setExtras] = useState<{ condition: AlertExtra['condition']; price: string }[]>([]);
  const [price, setPrice] = useState('');
  const [touched, setTouched] = useState(false);
  const [review, setReview] = useState<{ intent: AlertIntent; duplicate: boolean } | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<'create' | string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [unsure, setUnsure] = useState<Unsure | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [askingDelete, setAskingDelete] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [view, setView] = useState<AlertView>(DEFAULT_VIEW);
  const triggers = useTriggers();
  const quota = useAlertQuota();
  // One change at a time, even if a click lands twice before the screen redraws.
  const gate = useRef(createGate());

  const list = state.status === 'ready' ? state : null;
  const marketList: AlertMarket[] = markets.status === 'ready' ? markets.markets : [];
  const marketOf = (value: string) => marketList.find((market) => market.id === value);
  const selected = marketOf(marketId);
  const problem = touched ? priceProblem(price) : null;

  // A quota that could not be read blocks nothing: the service refuses a create past the cap on its own.
  const quotaState =
    quota.state.status !== 'ready'
      ? 'unknown'
      : quota.state.quota.max === null
        ? 'off'
        : quota.state.quota.used >= quota.state.quota.max
          ? 'full'
          : 'room';

  const blockedReason: BlockedReason | null =
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
                  : quotaState === 'off'
                    ? 'reasonQuotaOff'
                    : quotaState === 'full'
                      ? 'reasonQuotaFull'
                      : null;

  if (mode !== 'Personal') {
    return (
      <div data-testid="if-notify" className="if-notify">
        <div className="nf-head">
          <h1 data-testid="nf-h1" className="nf-h1">
            {copy.t('title')}
          </h1>
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
    if (
      blockedReason ||
      !marketId ||
      priceProblem(price) !== null ||
      expiryProblem(expires) !== null ||
      extras.some((extra) => priceProblem(extra.price) !== null) ||
      !list
    )
      return;
    const expiresAt = expiryIso(expires);
    const intent: AlertIntent = {
      marketId,
      direction: directionOfCondition(condition),
      condition,
      targetPrice: price.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(message.trim() ? { message: message.trim() } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(extras.length > 0 ? { extras: extras.map((extra) => ({ condition: extra.condition, targetPrice: extra.price.trim() })) } : {}),
      ...(repeat && isCrossing(condition) ? { frequency: 'every_crossing' as const } : {}),
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
        setExtras([]);
        setRepeat(false);
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
      // Every change can move the count, and a refusal for the cap means the count on screen was old.
      quota.reload();
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
      // Every change can move the count, and a refusal for the cap means the count on screen was old.
      quota.reload();
    }
  }

  /** Save one alert on each chosen market, all or none. Sent at most once: the service takes no request id. */
  async function saveWatchlist(intent: WatchlistIntent): Promise<'saved' | 'unknown' | 'refused'> {
    if (!userId || busy !== null || unsure) return 'refused';
    if (!gate.current.enter()) return 'refused';
    setBusy('watchlist');
    setNotice(null);
    try {
      const outcome = await submitWatchlist(api, intent, userId);
      if (outcome.kind === 'saved') setNotice({ kind: 'watchlistSaved' });
      else if (outcome.kind === 'refused') setNotice({ kind: 'refused', refusal: outcome.refusal });
      else setNotice({ kind: 'changeUnsure', what: 'watchlist' });
      if (outcome.kind !== 'refused') {
        reload();
        triggers.reload();
      }
      return outcome.kind === 'saved' ? 'saved' : outcome.kind === 'refused' ? 'refused' : 'unknown';
    } finally {
      gate.current.leave();
      setBusy(null);
      quota.reload();
    }
  }

  /** One change to an existing alert. The list is read again after anything that may have changed it. */
  async function change<T extends { kind: string }>(
    alert: PriceAlert,
    send: () => Promise<T | { kind: 'unknown' } | { kind: 'refused'; refusal: Refusal }>,
    done: (outcome: T) => Notice,
    what: 'active' | 'edit' | 'delete',
  ) {
    if (!userId || busy !== null || unsure) return;
    if (!gate.current.enter()) return;
    setBusy(alert.id);
    setNotice(null);
    try {
      const outcome = await send();
      setAsking(null);
      setAskingDelete(null);
      if (outcome.kind === 'unknown') setNotice({ kind: 'changeUnsure', what });
      else if (outcome.kind === 'refused') {
        const refusal = (outcome as { refusal: Refusal }).refusal;
        setNotice({ kind: 'refused', refusal });
        if (refusal === 'notEditable' || refusal === 'notFound') setEditing(null);
        if (refusal === 'notEditable' || refusal === 'notFound') reload();
      } else {
        setNotice(done(outcome as T));
        setEditing(null);
      }
      if (outcome.kind !== 'refused') {
        reload();
        triggers.reload();
      }
    } finally {
      gate.current.leave();
      setBusy(null);
      // Every change can move the count, and a refusal for the cap means the count on screen was old.
      quota.reload();
    }
  }

  const conditionWords = (value: AlertCondition) => copy.t(CONDITION_KEY[value]);
  const marketLabel = (value: string) => marketOf(value)?.label ?? copy.t('unlistedMarket');
  const shown = state.status === 'ready' ? visibleAlerts(state.items, view, marketLabel) : [];
  const evaluation = list?.evaluation ?? null;
  const priceId = `${id}-price`;

  return (
    <div data-testid="if-notify" className="if-notify">
      <div className="nf-head">
        <h1 data-testid="nf-h1" className="nf-h1">
          {copy.t('title')}
        </h1>
      </div>
      <NotifyNav current="alerts" />
      <p className="nf-intro">{copy.t('intro')}</p>
      {quota.state.status === 'ready' ? (
        <p className={`nf-banner${quotaState === 'room' ? ' nf-banner--ok' : ''}`} role="note" data-testid="alerts-quota">
          {quota.state.quota.max === null
            ? copy.t('quotaOff')
            : copy.t(quotaState === 'full' ? 'quotaFull' : 'quotaUsed', {
                used: String(quota.state.quota.used),
                max: String(quota.state.quota.max),
              })}
          {/* The owner's burst rule as it is now, where the limits are named; an alert's row says only that it was stopped. */}
          {quota.state.quota.burst
            ? ` ${copy.t('burstRule', { max: String(quota.state.quota.burst.maxTriggers), minutes: String(quota.state.quota.burst.windowMinutes) })}`
            : null}
        </p>
      ) : null}
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
        ) : notice?.kind === 'active' ? (
          <p className="nf-banner nf-banner--ok" role="status">
            {copy.t(ACTIVE[notice.words])}
          </p>
        ) : notice?.kind === 'watchlistSaved' ? (
          <p className="nf-banner nf-banner--ok" role="status">
            {copy.t('watchSaved')}
          </p>
        ) : notice?.kind === 'edited' ? (
          <p className="nf-banner nf-banner--ok" role="status">
            {copy.t('editedDone')}
          </p>
        ) : notice?.kind === 'deleted' ? (
          <p className="nf-banner nf-banner--ok" role="status">
            {copy.t(notice.gone ? 'deleteGone' : 'deletedDone')}
          </p>
        ) : notice?.kind === 'changeUnsure' ? (
          <div className="nf-banner nf-banner--warn" role="status">
            <strong>{copy.t(UNSURE[notice.what][0])}</strong>
            <p>{copy.t(UNSURE[notice.what][1])}</p>
          </div>
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
            {(review.intent.extras ?? []).map((extra, index) => (
              <div key={index}>
                <dt>{copy.t('reviewExtra')}</dt>
                <dd lang="zxx" className="nf-num">
                  {conditionWords(extra.condition)} {extra.targetPrice} {marketOf(review.intent.marketId)?.quote ?? ''}
                </dd>
              </div>
            ))}
            <div>
              <dt>{copy.t('reviewRepeat')}</dt>
              <dd>{copy.t(review.intent.frequency === 'every_crossing' ? 'repeatEvery' : 'repeatOnce')}</dd>
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
          {isCrossing(condition) ? (
            <label className="nf-check" data-testid="alerts-repeat">
              <input
                type="checkbox"
                checked={repeat}
                disabled={blockedReason !== null}
                onChange={(event) => setRepeat(event.target.checked)}
              />
              <span>{copy.t('repeatLabel')}</span>
            </label>
          ) : null}
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
          {extras.map((extra, index) => (
            <div className="nf-field" key={index} data-testid="alerts-extra">
              <span>{copy.t('extraLabel')}</span>
              <select
                aria-label={copy.t('extraLabel')}
                value={extra.condition}
                disabled={blockedReason !== null}
                onChange={(event) => {
                  const condition = event.target.value === 'less_than' ? 'less_than' : 'greater_than';
                  setExtras(extras.map((row, i) => (i === index ? { ...row, condition } : row)));
                }}
              >
                <option value="greater_than">{conditionWords('greater_than')}</option>
                <option value="less_than">{conditionWords('less_than')}</option>
              </select>
              <input
                inputMode="decimal"
                autoComplete="off"
                maxLength={64}
                aria-label={copy.t('extraPriceLabel')}
                value={extra.price}
                disabled={blockedReason !== null}
                aria-invalid={touched && priceProblem(extra.price) !== null}
                onChange={(event) => {
                  setExtras(extras.map((row, i) => (i === index ? { ...row, price: event.target.value } : row)));
                  setTouched(false);
                }}
              />
              {touched && priceProblem(extra.price) !== null ? <small className="nf-error">{copy.t('priceInvalid')}</small> : null}
              <Button
                variant="ghost"
                size={32}
                disabled={blockedReason !== null}
                onClick={() => setExtras(extras.filter((_, i) => i !== index))}
              >
                {copy.t('extraRemove')}
              </Button>
            </div>
          ))}
          <div className="nf-address__actions">
            <Button
              variant="secondary"
              size={32}
              disabled={blockedReason !== null}
              onClick={() => setExtras([...extras, { condition: 'less_than', price: '' }])}
            >
              {copy.t('extraAdd')}
            </Button>
          </div>
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

      <WatchlistAlert
        markets={marketList}
        userId={userId}
        room={
          quota.state.status === 'ready' && quota.state.quota.max !== null
            ? Math.max(0, quota.state.quota.max - quota.state.quota.used)
            : null
        }
        blockedReason={blockedReason}
        busy={busy === 'watchlist'}
        onSave={saveWatchlist}
      />

      <section
        data-testid="nf-card"
        className="nf-card"
        aria-label={copy.t('listLabel')}
        aria-busy={state.status === 'loading' || undefined}
      >
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
          <>
            <div className="nf-alertfind" data-testid="alerts-find">
              <label className="nf-field">
                <span>{copy.t('findLabel')}</span>
                <input
                  type="search"
                  autoComplete="off"
                  placeholder={copy.t('findPlaceholder')}
                  value={view.search}
                  onChange={(event) => setView({ ...view, search: event.target.value })}
                />
              </label>
              <label className="nf-field">
                <span>{copy.t('statusFilterLabel')}</span>
                <select
                  value={view.status}
                  onChange={(event) => {
                    const next = (['all', 'active', 'stopped', 'fired', 'expired', 'cancelled'] as const).find(
                      (v) => v === event.target.value,
                    );
                    if (next) setView({ ...view, status: next satisfies AlertStatusFilter });
                  }}
                >
                  <option value="all">{copy.t('statusAll')}</option>
                  {(Object.keys(STATUS) as (keyof typeof STATUS)[]).map((value) => (
                    <option key={value} value={value}>
                      {copy.t(STATUS[value])}
                    </option>
                  ))}
                </select>
              </label>
              <label className="nf-field">
                <span>{copy.t('sortLabel')}</span>
                <select
                  value={view.sort}
                  onChange={(event) => {
                    const next = (['newest', 'oldest', 'price'] as const).find((v) => v === event.target.value);
                    if (next) setView({ ...view, sort: next satisfies AlertSort });
                  }}
                >
                  <option value="newest">{copy.t('sortNewest')}</option>
                  <option value="oldest">{copy.t('sortOldest')}</option>
                  <option value="price">{copy.t('sortPrice')}</option>
                </select>
              </label>
            </div>
            {shown.length === 0 ? (
              <StateBlock kind="empty" title={copy.t('noMatchTitle')} body={copy.t('noMatchBody')} />
            ) : (
              <ul className="nf-list" data-testid="alerts-list">
                {shown.map((alert) => {
                  const market = marketOf(alert.marketId);
                  const name = market?.label ?? copy.t('unlistedMarket');
                  const kind = alert.kind === 'price' ? null : copy.t(KIND[alert.kind]);
                  return (
                    <li key={alert.id} className="nf-alertrow" data-testid="alert-row" data-status={alert.status}>
                      <div className="nf-text">
                        <span data-testid="nf-title" className="nf-title">
                          {alert.name ? alert.name : kind ? `${name} · ${kind}` : name}
                        </span>
                        <span data-testid="nf-body" className="nf-body nf-body--wrap">
                          {copy.t('condition', {
                            side: conditionWords(alert.condition ?? (alert.direction === 'below' ? 'less_than' : 'greater_than')),
                            price: alert.targetPrice,
                          }) + (alert.kind === 'price' && market ? ` ${market.quote}` : '')}
                        </span>
                        {(alert.extras ?? []).map((extra, index) => (
                          <span data-testid="nf-body" className="nf-body nf-body--wrap" key={index}>
                            {copy.t('listAnd', { side: conditionWords(extra.condition), price: extra.targetPrice }) +
                              (alert.kind === 'price' && market ? ` ${market.quote}` : '')}
                          </span>
                        ))}
                        {alert.message ? (
                          <span data-testid="nf-body" className="nf-body nf-body--wrap">
                            {alert.message}
                          </span>
                        ) : null}
                        {alert.frequency === 'every_crossing' ? (
                          <span className="nf-body nf-body--wrap" data-testid="alert-repeats">
                            {copy.t('repeatList', { count: String(alert.fireCount ?? 0) }) +
                              (alert.lastFiredAt ? ` · ${copy.t('repeatLast', { when: stamp(alert.lastFiredAt, timeZone) })}` : '')}
                          </span>
                        ) : null}
                        {alert.status === 'stopped' && alert.stopReason === 'burst' ? (
                          <span className="nf-body nf-body--wrap" data-testid="alert-stop-reason">
                            {copy.t(alert.kind === 'price' ? 'stoppedBurst' : 'stoppedBurstNoResume')}
                          </span>
                        ) : null}
                        <span className="nf-muted">
                          {copy.t('created', { when: stamp(alert.createdAt, timeZone) }) +
                            // An open alert's last change (an edit, a stop or a resume); a finished one's is its end, already named.
                            ((alert.status === 'active' || alert.status === 'stopped') &&
                            alert.updatedAt &&
                            Date.parse(alert.updatedAt) > Date.parse(alert.createdAt)
                              ? ` · ${copy.t('modifiedAt', { when: stamp(alert.updatedAt, timeZone) })}`
                              : '') +
                            (alert.firedAt ? ` · ${copy.t('firedAt', { when: stamp(alert.firedAt, timeZone) })}` : '') +
                            (alert.expiresAt
                              ? ` · ${copy.t(alert.status === 'expired' ? 'expiredAt' : 'expiresAt', { when: stamp(alert.expiresAt, timeZone) })}`
                              : '')}
                        </span>
                      </div>
                      <div className="nf-alertside">
                        <span className={`nf-pill${alert.status === 'active' ? ' nf-pill--ok' : ''}`}>{copy.t(STATUS[alert.status])}</span>
                        <div className="nf-alertbuttons">
                          {alert.kind === 'price' && (alert.status === 'active' || alert.status === 'stopped') ? (
                            <Button
                              variant="ghost"
                              size={28}
                              disabled={busy !== null || unsure !== null}
                              aria-label={copy.t(alert.status === 'active' ? 'pauseAria' : 'resumeAria', { market: name })}
                              onClick={() =>
                                void change(
                                  alert,
                                  () => submitActive(api, alert.id, alert.status !== 'active', userId ?? ''),
                                  (outcome) => ({ kind: 'active', words: outcome.words }),
                                  'active',
                                )
                              }
                            >
                              {copy.t(alert.status === 'active' ? 'pauseAlert' : 'resumeAlert')}
                            </Button>
                          ) : null}
                          {canEdit(alert) && editing !== alert.id ? (
                            <Button
                              variant="ghost"
                              size={28}
                              disabled={busy !== null || unsure !== null}
                              aria-label={copy.t('editAria', { market: name })}
                              onClick={() => setEditing(alert.id)}
                            >
                              {copy.t('editAlert')}
                            </Button>
                          ) : null}
                          {(alert.status === 'active' || alert.status === 'stopped') && asking !== alert.id ? (
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
                          {askingDelete !== alert.id ? (
                            <Button
                              variant="ghost"
                              size={28}
                              disabled={busy !== null || unsure !== null}
                              aria-label={copy.t('deleteAria', { market: name })}
                              onClick={() => setAskingDelete(alert.id)}
                            >
                              {copy.t('deleteAlert')}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {editing === alert.id && canEdit(alert) ? (
                        <AlertEditPanel
                          alert={alert}
                          quote={market?.quote ?? ''}
                          busy={busy === alert.id}
                          onClose={() => setEditing(null)}
                          onSave={(edit) =>
                            void change(
                              alert,
                              () => submitEdit(api, alert.id, edit, userId ?? ''),
                              () => ({ kind: 'edited' }),
                              'edit',
                            )
                          }
                        />
                      ) : null}
                      {askingDelete === alert.id ? (
                        <div className="nf-alertask" role="group" aria-label={copy.t('deleteAsk')}>
                          <p>{copy.t('deleteAsk')}</p>
                          <div className="nf-address__actions">
                            <Button variant="secondary" size={32} disabled={busy !== null} onClick={() => setAskingDelete(null)}>
                              {copy.t('deleteKeep')}
                            </Button>
                            <Button
                              size={32}
                              loading={busy === alert.id}
                              disabled={busy !== null}
                              onClick={() =>
                                void change(
                                  alert,
                                  () => submitDelete(api, alert.id),
                                  (outcome) => ({ kind: 'deleted', gone: !outcome.deleted }),
                                  'delete',
                                )
                              }
                            >
                              {copy.t(busy === alert.id ? 'deleting' : 'deleteConfirm')}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {asking === alert.id ? (
                        <div className="nf-alertask" role="group" aria-label={copy.t('cancelAsk')}>
                          <p>{copy.t('cancelAsk')}</p>
                          <div className="nf-address__actions">
                            <Button variant="secondary" size={32} disabled={busy !== null} onClick={() => setAsking(null)}>
                              {copy.t('cancelKeep')}
                            </Button>
                            <Button
                              size={32}
                              loading={busy === alert.id}
                              disabled={busy !== null}
                              onClick={() => void confirmCancel(alert)}
                            >
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
          </>
        )}
      </section>
      <p className="nf-note">{copy.t('listBoundary')}</p>
      <TriggerLog state={triggers.state} onRetry={triggers.reload} marketLabel={marketLabel} />
    </div>
  );
}
