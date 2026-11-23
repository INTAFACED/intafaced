import { useId, useRef, useState } from 'react';
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
  SOURCE_KEY,
} from './alerts-model';
import { AlertEditPanel } from './AlertEditPanel';
import { AlertDelivery, deliveryIntent, NO_DELIVERY_CHOICE, useDeliveryFacts, webhookProblem, type DeliveryChoice } from './AlertDelivery';
import { TriggerLog } from './TriggerLog';
import { WatchlistAlert, type BlockedReason } from './WatchlistAlert';
import { FollowListAlert } from './FollowListAlert';
import { useAlertQuota } from './use-quota';
import { useTriggers } from './use-triggers';
import { Button, EmptyState, DateInput } from '@intafaced/ui/lit';
import { LoadFailed, Loading, StateTag } from './parts';
import {
  ALERT_CONDITIONS,
  ALERT_SOURCES,
  type AlertSource,
  directionOfCondition,
  isCrossing,
  listAlerts,
  type AlertCondition,
  type AlertExtra,
  type AlertIntent,
  type PriceAlert,
  type WatchlistIntent,
} from './notify-api';
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
  webhookOff: 'refusedWebhookOff',
  webhookRejected: 'refusedWebhookRejected',
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
  'webhookOff',
  'webhookRejected',
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
  const [source, setSource] = useState<AlertSource>('mark');
  // Where the alert reaches the person besides the app: email, push and their own webhook (J-charts-desk-10).
  const [delivery, setDelivery] = useState<DeliveryChoice>(NO_DELIVERY_CHOICE);
  const deliveryFacts = useDeliveryFacts();
  // What the alert is on. Only a price alert can be saved; an indicator alert is listed and refused until it is built.
  const [alertKind, setAlertKind] = useState<'price' | 'indicator'>('price');
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
  // The most conditions an alert may hold (the main one included), when the owner has set it: the form stops at it.
  const maxConditions = quota.state.status === 'ready' ? (quota.state.quota.maxConditions ?? null) : null;
  // Until the cap is read, nothing past the main condition can be added: the form never lets through what it cannot check.
  // A cap still loading or unreadable says so; a cap the service reports as blank refuses extra conditions up front.
  const conditionCapNote: 'extraCapLoading' | 'extraCapFailed' | 'extraCapUnset' | null =
    quota.state.status === 'loading'
      ? 'extraCapLoading'
      : quota.state.status === 'failed'
        ? 'extraCapFailed'
        : maxConditions === null
          ? 'extraCapUnset'
          : null;
  const atConditionCap = conditionCapNote !== null || (maxConditions !== null && 1 + extras.length >= maxConditions);
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
  // An indicator alert is refused, so the price rule's own fields lock with it: nothing typed there could be saved.
  const priceFormLocked = blockedReason !== null || alertKind !== 'price';

  if (mode !== 'Personal') {
    return (
      <>
        <p className="lt-hint" role="note">
          {copy.t('businessNote')}
        </p>
      </>
    );
  }

  function toReview() {
    setNotice(null);
    if (alertKind !== 'price') return;
    setTouched(true);
    if (
      blockedReason ||
      !marketId ||
      priceProblem(price) !== null ||
      expiryProblem(expires) !== null ||
      extras.some((extra) => priceProblem(extra.price) !== null) ||
      webhookProblem(delivery.webhookUrl) !== null ||
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
      ...(source !== 'mark' ? { source } : {}),
      ...deliveryIntent(delivery),
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
        setSource('mark');
        setDelivery(NO_DELIVERY_CHOICE);
        setAlertKind('price');
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
    <>
      <p className="lt-hint">{copy.t('intro')}</p>
      {quota.state.status === 'ready' ? (
        <p role="note" data-testid="alerts-quota">
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
        <p role="note" data-testid="alerts-evaluation">
          {copy.t(evaluationNote(evaluation))}
        </p>
      ) : null}

      <div aria-live="polite" data-testid="alerts-notices">
        {notice?.kind === 'saved' ? (
          <p role="status">{copy.t(notice.found ? 'savedFound' : 'saved')}</p>
        ) : notice?.kind === 'cancelled' ? (
          <p role="status">{copy.t(CANCEL[notice.words])}</p>
        ) : notice?.kind === 'active' ? (
          <p role="status">{copy.t(ACTIVE[notice.words])}</p>
        ) : notice?.kind === 'watchlistSaved' ? (
          <p role="status">{copy.t('watchSaved')}</p>
        ) : notice?.kind === 'edited' ? (
          <p role="status">{copy.t('editedDone')}</p>
        ) : notice?.kind === 'deleted' ? (
          <p role="status">{copy.t(notice.gone ? 'deleteGone' : 'deletedDone')}</p>
        ) : notice?.kind === 'changeUnsure' ? (
          <div className="lt-refusal" role="status">
            <strong>{copy.t(UNSURE[notice.what][0])}</strong>
            <p>{copy.t(UNSURE[notice.what][1])}</p>
          </div>
        ) : notice?.kind === 'refused' ? (
          <p className="lt-refusal" role="alert">
            {copy.t(REFUSAL[notice.refusal])}
          </p>
        ) : notice?.kind === 'cancelUnsure' ? (
          <div className="lt-refusal" role="status">
            <strong>{copy.t('cancelUnsureTitle')}</strong>
            <p>{copy.t('cancelUnsureBody')}</p>
          </div>
        ) : null}
        {unsure ? (
          <div className="lt-refusal" role="status" data-testid="alerts-unsure">
            <strong>{copy.t('unsureTitle')}</strong>
            <p>{copy.t('unsureBody')}</p>
            {unsure.phase === 'checking' ? <p className="lt-hint">{copy.t('unsureChecking')}</p> : null}
            {unsure.phase === 'absent' ? <p>{copy.t('unsureAbsent')}</p> : null}
            {unsure.phase === 'checkFailed' ? <p>{copy.t('unsureCheckFailed')}</p> : null}
            <div className="lt-actions">
              {unsure.phase === 'checkFailed' ? (
                <Button tone="primary" onClick={() => void check(unsure)}>
                  {copy.t('unsureCheckAgain')}
                </Button>
              ) : null}
              {unsure.phase === 'absent' ? (
                <>
                  <Button
                    tone="primary"
                    onClick={() => {
                      // The first create may still land after the re-check, so warn again from the latest list.
                      setReview({ intent: unsure.intent, duplicate: list ? findDuplicate(list.items, unsure.intent) !== null : false });
                      setAck(false);
                      setUnsure(null);
                    }}
                  >
                    {copy.t('unsureSaveAgain')}
                  </Button>
                  <Button tone="quiet" onClick={() => setUnsure(null)}>
                    {copy.t('unsureDismiss')}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {review ? (
        <section aria-labelledby={`${id}-review`} data-testid="alerts-review">
          <h2 id={`${id}-review`}>{copy.t('reviewTitle')}</h2>
          <dl className="lt-kv">
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
                <dd lang="zxx" className="lt-mono">
                  {conditionWords(extra.condition)} {extra.targetPrice} {marketOf(review.intent.marketId)?.quote ?? ''}
                </dd>
              </div>
            ))}
            <div>
              <dt>{copy.t('reviewSource')}</dt>
              <dd>{copy.t(SOURCE_KEY[review.intent.source ?? 'mark'])}</dd>
            </div>
            <div>
              <dt>{copy.t('reviewRepeat')}</dt>
              <dd>{copy.t(review.intent.frequency === 'every_crossing' ? 'repeatEvery' : 'repeatOnce')}</dd>
            </div>
            <div>
              <dt>{copy.t('reviewDelivery')}</dt>
              <dd data-testid="alerts-review-delivery">
                {[
                  copy.t('deliveryInApp'),
                  ...(review.intent.channels ?? []).map((c) => copy.t(c === 'email' ? 'deliveryEmail' : 'deliveryPush')),
                ].join(', ')}
              </dd>
            </div>
            {review.intent.webhookUrl ? (
              <div>
                <dt>{copy.t('reviewWebhook')}</dt>
                <dd lang="zxx" data-testid="alerts-review-webhook">
                  {review.intent.webhookUrl}
                </dd>
              </div>
            ) : null}
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
              <dd lang="zxx" className="lt-mono">
                {review.intent.targetPrice} {marketOf(review.intent.marketId)?.quote ?? ''}
              </dd>
            </div>
          </dl>
          <p className="lt-hint">{copy.t('reviewOnce')}</p>
          {evaluation ? <p className="lt-hint">{copy.t(evaluationNote(evaluation))}</p> : null}
          {review.duplicate ? (
            <p className="lt-refusal" role="note">
              {copy.t('reviewDuplicate')}
            </p>
          ) : null}
          {evaluation && !evaluation.canFire ? (
            <label className="lt-field">
              <input type="checkbox" checked={ack} disabled={busy !== null} onChange={(event) => setAck(event.target.checked)} />
              <span>{copy.t('reviewAck')}</span>
            </label>
          ) : null}
          <div className="lt-actions">
            <Button tone="secondary" disabled={busy !== null} onClick={() => setReview(null)}>
              {copy.t('back')}
            </Button>
            <Button
              tone="primary"
              aria-busy={busy === 'create' || undefined}
              disabled={busy !== null || (evaluation !== null && !evaluation.canFire && !ack)}
              onClick={() => void confirmSave()}
            >
              {copy.t(busy === 'create' ? 'saving' : 'save')}
            </Button>
          </div>
        </section>
      ) : (
        <form
          noValidate
          aria-labelledby={`${id}-new`}
          data-testid="alerts-form"
          onSubmit={(event) => {
            event.preventDefault();
            toReview();
          }}
        >
          <h2 id={`${id}-new`}>{copy.t('newTitle')}</h2>
          <label className="lt-field">
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
          <label className="lt-field">
            <span>{copy.t('kindLabel')}</span>
            <select
              value={alertKind}
              disabled={blockedReason !== null}
              onChange={(event) => setAlertKind(event.target.value === 'indicator' ? 'indicator' : 'price')}
            >
              <option value="price">{copy.t('kindPrice')}</option>
              <option value="indicator">{copy.t('kindIndicator')}</option>
            </select>
          </label>
          {alertKind === 'indicator' ? (
            <p className="lt-hint" role="status" data-testid="alerts-kind-refused">
              {copy.t('kindIndicatorRefused')}
            </p>
          ) : null}
          <label className="lt-field">
            <span>{copy.t('conditionLabel')}</span>
            <select
              value={condition}
              disabled={priceFormLocked}
              onChange={(event) => setCondition(ALERT_CONDITIONS.find((c) => c === event.target.value) ?? 'greater_than')}
            >
              {ALERT_CONDITIONS.map((value) => (
                <option key={value} value={value}>
                  {conditionWords(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="lt-field">
            <span>{copy.t('sourceLabel')}</span>
            <select
              value={source}
              disabled={priceFormLocked}
              onChange={(event) => setSource(ALERT_SOURCES.find((value) => value === event.target.value) ?? 'mark')}
            >
              {ALERT_SOURCES.map((value) => (
                <option key={value} value={value}>
                  {copy.t(SOURCE_KEY[value])}
                </option>
              ))}
            </select>
          </label>
          {isCrossing(condition) ? (
            <label className="lt-field" data-testid="alerts-repeat">
              <input type="checkbox" checked={repeat} disabled={priceFormLocked} onChange={(event) => setRepeat(event.target.checked)} />
              <span>{copy.t('repeatLabel')}</span>
            </label>
          ) : null}
          <label className="lt-field" htmlFor={priceId}>
            <span>{selected ? copy.t('priceLabel', { quote: selected.quote }) : copy.t('priceLabelNoMarket')}</span>
            <input
              id={priceId}
              inputMode="decimal"
              autoComplete="off"
              maxLength={64}
              value={price}
              disabled={priceFormLocked}
              aria-invalid={problem !== null}
              aria-describedby={`${priceId}-help`}
              onChange={(event) => {
                setPrice(event.target.value);
                setTouched(false);
              }}
            />
            <small id={`${priceId}-help`} data-part={problem ? 'error' : undefined}>
              {problem === 'empty' ? copy.t('priceEmpty') : problem === 'invalid' ? copy.t('priceInvalid') : copy.t('priceHint')}
            </small>
          </label>
          {extras.map((extra, index) => (
            <div className="lt-field" key={index} data-testid="alerts-extra">
              <span>{copy.t('extraLabel')}</span>
              <select
                aria-label={copy.t('extraLabel')}
                value={extra.condition}
                disabled={priceFormLocked}
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
                disabled={priceFormLocked}
                aria-invalid={touched && priceProblem(extra.price) !== null}
                onChange={(event) => {
                  setExtras(extras.map((row, i) => (i === index ? { ...row, price: event.target.value } : row)));
                  setTouched(false);
                }}
              />
              {touched && priceProblem(extra.price) !== null ? <small data-part="error">{copy.t('priceInvalid')}</small> : null}
              <Button tone="quiet" disabled={priceFormLocked} onClick={() => setExtras(extras.filter((_, i) => i !== index))}>
                {copy.t('extraRemove')}
              </Button>
            </div>
          ))}
          <div className="lt-actions">
            <Button
              tone="secondary"
              disabled={priceFormLocked || atConditionCap}
              onClick={() => setExtras([...extras, { condition: 'less_than', price: '' }])}
            >
              {copy.t('extraAdd')}
            </Button>
          </div>
          {conditionCapNote !== null ? (
            <p
              className="lt-hint"
              data-testid="alerts-extra-cap"
              data-cap={conditionCapNote === 'extraCapUnset' ? 'unset' : quota.state.status}
            >
              {copy.t(conditionCapNote)}
            </p>
          ) : atConditionCap && maxConditions !== null ? (
            <p className="lt-hint" data-testid="alerts-extra-cap">
              {copy.t('extraCap', { max: String(maxConditions) })}
            </p>
          ) : null}
          <label className="lt-field">
            <span>{copy.t('nameLabel')}</span>
            <input autoComplete="off" value={name} disabled={priceFormLocked} onChange={(event) => setName(event.target.value)} />
            <small className="lt-hint">{copy.t('nameHint')}</small>
          </label>
          <label className="lt-field">
            <span>{copy.t('messageLabel')}</span>
            <input autoComplete="off" value={message} disabled={priceFormLocked} onChange={(event) => setMessage(event.target.value)} />
            <small className="lt-hint">
              {copy.t('messageHint', { market: '{market}', price: '{price}', condition: '{condition}', time: '{time}' })}
            </small>
          </label>
          <label className="lt-field">
            <span>{copy.t('expiresLabel')}</span>
            <DateInput
              type="datetime-local"
              value={expires}
              disabled={priceFormLocked}
              aria-invalid={expiryProblem(expires) !== null}
              onChange={(event) => setExpires(event.target.value)}
            />
            <small data-part={expiryProblem(expires) ? 'error' : undefined}>
              {expiryProblem(expires) ? copy.t('expiresInvalid') : copy.t('expiresHint')}
            </small>
          </label>
          <AlertDelivery value={delivery} onChange={setDelivery} disabled={priceFormLocked} facts={deliveryFacts} />
          <div className="lt-actions">
            <Button tone="primary" type="submit" disabled={blockedReason !== null || alertKind !== 'price'}>
              {copy.t('review')}
            </Button>
          </div>
          {blockedReason ? (
            <p className="lt-hint" data-testid="alerts-reason">
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

      <FollowListAlert
        markets={marketList}
        blockedReason={blockedReason}
        stamp={(iso) => stamp(iso, timeZone)}
        onChanged={() => {
          reload();
          quota.reload();
        }}
      />

      <section
        data-testid="nf-card"

        aria-label={copy.t('listLabel')}
        aria-busy={state.status === 'loading' || undefined}
      >
        <div className="lt-title-row">
          <h2>{copy.t('listTitle')}</h2>
          <Button tone="quiet" disabled={busy !== null} onClick={reload}>
            {copy.t('refresh')}
          </Button>
        </div>
        {state.status === 'loading' ? (
          <Loading label={copy.t('loadingList')} rows={3} />
        ) : state.status === 'failed' ? (
          <LoadFailed title={copy.t('listFailed')} onRetry={reload} retryLabel={copy.t('retry')} />
        ) : state.items.length === 0 ? (
          <EmptyState title={copy.t('emptyTitle')} body={copy.t('emptyBody')} />
        ) : (
          <>
            <div className="lt-actions" data-testid="alerts-find">
              <label className="lt-field">
                <span>{copy.t('findLabel')}</span>
                <input
                  type="search"
                  autoComplete="off"
                  placeholder={copy.t('findPlaceholder')}
                  value={view.search}
                  onChange={(event) => setView({ ...view, search: event.target.value })}
                />
              </label>
              <label className="lt-field">
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
              <label className="lt-field">
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
              <EmptyState title={copy.t('noMatchTitle')} body={copy.t('noMatchBody')} />
            ) : (
              <ul className="lt-rows" data-testid="alerts-list">
                {shown.map((alert) => {
                  const market = marketOf(alert.marketId);
                  const name = market?.label ?? copy.t('unlistedMarket');
                  const kind = alert.kind === 'price' ? null : copy.t(KIND[alert.kind]);
                  return (
                    <li key={alert.id} data-testid="alert-row" data-status={alert.status}>
                      <div className="lt-lines">
                        <span data-testid="nf-title">{alert.name ? alert.name : kind ? `${name} · ${kind}` : name}</span>
                        {/* A named alert's title is its name, so its market is shown on its own line. */}
                        {alert.name ? <span data-testid="alert-market">{kind ? `${name} · ${kind}` : name}</span> : null}
                        <span data-testid="nf-body">
                          {copy.t('condition', {
                            side: conditionWords(alert.condition ?? (alert.direction === 'below' ? 'less_than' : 'greater_than')),
                            price: alert.targetPrice,
                          }) +
                            (alert.kind === 'price' && market ? ` ${market.quote}` : '') +
                            (alert.source && alert.source !== 'mark' ? ` · ${copy.t(SOURCE_KEY[alert.source])}` : '')}
                        </span>
                        {(alert.extras ?? []).map((extra, index) => (
                          <span data-testid="nf-body" key={index}>
                            {copy.t('listAnd', { side: conditionWords(extra.condition), price: extra.targetPrice }) +
                              (alert.kind === 'price' && market ? ` ${market.quote}` : '')}
                          </span>
                        ))}
                        {alert.message ? <span data-testid="nf-body">{alert.message}</span> : null}
                        {alert.frequency === 'every_crossing' ? (
                          <span data-testid="alert-repeats">
                            {copy.t('repeatList', { count: String(alert.fireCount ?? 0) }) +
                              (alert.lastFiredAt ? ` · ${copy.t('repeatLast', { when: stamp(alert.lastFiredAt, timeZone) })}` : '')}
                          </span>
                        ) : null}
                        {alert.status === 'stopped' && alert.stopReason === 'burst' ? (
                          <span data-testid="alert-stop-reason">
                            {copy.t(alert.kind === 'price' ? 'stoppedBurst' : 'stoppedBurstNoResume')}
                          </span>
                        ) : null}
                        <span className="lt-hint" data-testid="alert-dates">
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
                      <div className="lt-actions">
                        <StateTag ok={alert.status === 'active'} data-testid="alert-status">
                          {copy.t(STATUS[alert.status])}
                        </StateTag>
                        <div className="lt-actions">
                          {alert.kind === 'price' && (alert.status === 'active' || alert.status === 'stopped') ? (
                            <Button
                              tone="quiet"
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
                              tone="quiet"
                              disabled={busy !== null || unsure !== null}
                              aria-label={copy.t('editAria', { market: name })}
                              onClick={() => setEditing(alert.id)}
                            >
                              {copy.t('editAlert')}
                            </Button>
                          ) : null}
                          {(alert.status === 'active' || alert.status === 'stopped') && asking !== alert.id ? (
                            <Button
                              tone="quiet"
                              disabled={busy !== null || unsure !== null}
                              aria-label={copy.t('cancelAria', { market: name })}
                              onClick={() => setAsking(alert.id)}
                            >
                              {copy.t('cancelAlert')}
                            </Button>
                          ) : null}
                          {askingDelete !== alert.id ? (
                            <Button
                              tone="quiet"
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
                        <div role="group" aria-label={copy.t('deleteAsk')}>
                          <p>{copy.t('deleteAsk')}</p>
                          <div className="lt-actions">
                            <Button tone="secondary" disabled={busy !== null} onClick={() => setAskingDelete(null)}>
                              {copy.t('deleteKeep')}
                            </Button>
                            <Button
                              tone="primary"
                              aria-busy={busy === alert.id || undefined}
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
                        <div role="group" aria-label={copy.t('cancelAsk')}>
                          <p>{copy.t('cancelAsk')}</p>
                          <div className="lt-actions">
                            <Button tone="secondary" disabled={busy !== null} onClick={() => setAsking(null)}>
                              {copy.t('cancelKeep')}
                            </Button>
                            <Button
                              tone="primary"
                              aria-busy={busy === alert.id || undefined}
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
      <p className="lt-hint">{copy.t('listBoundary')}</p>
      <TriggerLog state={triggers.state} onRetry={triggers.reload} marketLabel={marketLabel} />
    </>
  );
}
