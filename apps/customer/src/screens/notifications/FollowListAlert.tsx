/**
 * Following a watchlist (J-charts-desk-09 #7, C-alerts-scan-03): one alert on every market of one of the person's account
 * watchlists (`trade.watchlists`, kept beside the chart), and a market added to that list later picked up by the service at its
 * next price check. The page sends only which list and the rule; the service reads the list itself, so what is followed is the
 * list on the account, not a copy taken here.
 *
 * Each market gets an ordinary price alert, listed and managed on its own below. The followed lists are listed here with what
 * they cover and, when the last check added nothing it should have (the lists or markets could not be read, the list is gone,
 * the quota is full), the reason in words. Stopping a follow keeps its alerts.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useWatchlists } from '../../features/watchlists/store';
import { useSession } from '../../features/session/session';
import type { ApiResult } from '../../shared/api';
import { alertsCopy } from './alerts-copy';
import { priceProblem } from './alerts-model';
import { Button } from './deps';
import {
  ALERT_CONDITIONS,
  createWatchRule,
  listWatchRules,
  stopWatchRule,
  type AlertCondition,
  type FollowIntent,
  type WatchRule,
} from './notify-api';
import type { AlertMarket } from './use-alerts';
import type { BlockedReason } from './WatchlistAlert';

const CONDITION_KEY = {
  greater_than: 'above',
  less_than: 'below',
  crossing_up: 'crossingUp',
  crossing_down: 'crossingDown',
  crossing: 'crossing',
} as const satisfies Record<AlertCondition, string>;

const REFUSAL_KEY = {
  'identity.watchlists_unavailable': 'followRefusedLists',
  'alert.watchlist_not_found': 'followRefusedGone',
  'alert.markets_unavailable': 'followRefusedMarkets',
  'alert.quota_reached': 'refusedQuotaReached',
  'notify.alert_quota_unset': 'refusedQuotaOff',
  'notify.price_unset': 'followRefusedPrice',
  'alert.invalid_market': 'followEmptyList',
} as const;

const SYNC_KEY = {
  'identity.watchlists_unavailable': 'followSyncLists',
  'alert.watchlist_not_found': 'followSyncGone',
  'alert.markets_unavailable': 'followSyncMarkets',
  'alert.quota_reached': 'followSyncQuota',
  'notify.alert_quota_unset': 'followSyncQuotaOff',
} as const;

/** Answers that do not say whether the write was stored. */
const UNSURE: ReadonlySet<string> = new Set(['uncertain', 'unreachable', 'invalid_response', 'aborted']);

type Failure = Extract<ApiResult<unknown>, { ok: false }>;
function refusalOf(result: Failure): keyof typeof REFUSAL_KEY | null {
  const text = `${result.code ?? ''} ${result.message ?? ''}`;
  return (Object.keys(REFUSAL_KEY) as (keyof typeof REFUSAL_KEY)[]).find((code) => text.includes(code)) ?? null;
}

type Note = { tone: 'ok' | 'bad'; text: string };

export function FollowListAlert({
  markets,
  blockedReason,
  stamp,
  onChanged,
}: {
  markets: readonly AlertMarket[];
  blockedReason: BlockedReason | null;
  /** A time in the person's own zone, as the rest of the page writes it. */
  stamp: (iso: string) => string;
  /** The alerts list and the quota are read again after a change. */
  onChanged: () => void;
}) {
  const copy = alertsCopy.useCopy();
  const id = useId();
  const { api, userId } = useSession();
  const lists = useWatchlists();
  const [rules, setRules] = useState<{ status: 'loading' | 'failed' } | { status: 'ready'; items: WatchRule[] }>({ status: 'loading' });
  const [cycle, setCycle] = useState(0);
  const [listId, setListId] = useState('');
  const [condition, setCondition] = useState<AlertCondition>('greater_than');
  const [price, setPrice] = useState('');
  const [touched, setTouched] = useState(false);
  const [review, setReview] = useState<FollowIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void listWatchRules(api, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setRules(result.ok ? { status: 'ready', items: result.data.items } : { status: 'failed' });
    });
    return () => controller.abort();
  }, [api, userId, cycle]);
  const reloadRules = useCallback(() => setCycle((value) => value + 1), []);

  const accountLists = lists.status === 'ready' ? lists.value : [];
  const chosen = accountLists.find((list) => list.id === listId) ?? accountLists[0] ?? null;
  const labelOf = useMemo(() => new Map(markets.map((market) => [market.id, market.label])), [markets]);
  const watchable = useMemo(() => {
    const listed = new Set(markets.map((market) => market.label));
    return chosen ? chosen.sections.flatMap((section) => section.symbols).filter((symbol) => listed.has(symbol)) : [];
  }, [chosen, markets]);
  const problem = touched ? priceProblem(price) : null;
  const locked = blockedReason !== null || busy;

  function toReview() {
    setTouched(true);
    setNote(null);
    if (locked || !chosen || watchable.length === 0 || priceProblem(price) !== null) return;
    setReview({ listId: chosen.id, condition, targetPrice: price.trim() });
  }

  async function save(intent: FollowIntent) {
    if (!userId || busy) return;
    setBusy(true);
    try {
      const result = await createWatchRule(api, intent, userId);
      if (result.ok) {
        setReview(null);
        setPrice('');
        setTouched(false);
        setNote({ tone: 'ok', text: copy.t('followSaved', { list: result.data.rule.listName }) });
      } else if (UNSURE.has(result.reason)) {
        // A save that may have landed is over: saving the same follow again could make a second one.
        setReview(null);
        setNote({ tone: 'bad', text: copy.t('followUnsure') });
      } else {
        const code = refusalOf(result);
        setNote({ tone: 'bad', text: copy.t(code ? REFUSAL_KEY[code] : 'followRefused') });
      }
    } finally {
      setBusy(false);
      reloadRules();
      onChanged();
    }
  }

  async function stop(rule: WatchRule) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await stopWatchRule(api, rule.id);
      setNote(
        result.ok && result.data.rule
          ? { tone: 'ok', text: copy.t('followStopped', { list: rule.listName }) }
          : { tone: 'bad', text: copy.t(result.ok ? 'followRefused' : UNSURE.has(result.reason) ? 'followStopUnsure' : 'followRefused') },
      );
    } finally {
      setBusy(false);
      reloadRules();
    }
  }

  return (
    <section className="nf-card nf-alertform" aria-labelledby={`${id}-title`} data-testid="alerts-follow">
      <h2 className="nf-h2" id={`${id}-title`}>
        {copy.t('followTitle')}
      </h2>
      <p className="nf-muted">{copy.t('followIntro')}</p>
      {lists.status === 'loading' ? (
        <p className="nf-muted">{copy.t('followListsLoading')}</p>
      ) : lists.status !== 'ready' ? (
        <p className="nf-muted" data-testid="alerts-follow-unread">
          {copy.t('followListsFailed')}
        </p>
      ) : accountLists.length === 0 ? (
        <p className="nf-muted" data-testid="alerts-follow-empty">
          {copy.t('followNoLists')}
        </p>
      ) : review && chosen ? (
        <div data-testid="alerts-follow-review">
          <h3 className="nf-h2">{copy.t('followReviewTitle')}</h3>
          <dl className="nf-facts">
            <div>
              <dt>{copy.t('followReviewList')}</dt>
              <dd>{chosen.name}</dd>
            </div>
            <div>
              <dt>{copy.t('followReviewMarkets')}</dt>
              <dd>{watchable.join(', ')}</dd>
            </div>
            <div>
              <dt>{copy.t('reviewWhen')}</dt>
              <dd lang="zxx" className="nf-num">
                {copy.t(CONDITION_KEY[review.condition])} {review.targetPrice}
              </dd>
            </div>
          </dl>
          <p className="nf-muted">{copy.t('followLater')}</p>
          <div className="nf-address__actions">
            <Button variant="secondary" size={32} disabled={busy} onClick={() => setReview(null)}>
              {copy.t('back')}
            </Button>
            <Button size={32} loading={busy} disabled={locked} onClick={() => void save(review)}>
              {copy.t(busy ? 'saving' : 'followSave')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            toReview();
          }}
        >
          <fieldset className="nf-field" disabled={locked}>
            <label className="nf-field">
              <span>{copy.t('followList')}</span>
              <select value={chosen?.id ?? ''} onChange={(event) => setListId(event.target.value)}>
                {accountLists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="nf-muted" data-testid="alerts-follow-markets">
              {watchable.length > 0 ? copy.t('followMarketsNow', { markets: watchable.join(', ') }) : copy.t('followEmptyList')}
            </p>
            <label className="nf-field">
              <span>{copy.t('followCondition')}</span>
              <select value={condition} onChange={(event) => setCondition(event.target.value as AlertCondition)}>
                {ALERT_CONDITIONS.map((value) => (
                  <option key={value} value={value}>
                    {copy.t(CONDITION_KEY[value])}
                  </option>
                ))}
              </select>
            </label>
            <label className="nf-field">
              <span>{copy.t('followPrice')}</span>
              <input
                inputMode="decimal"
                autoComplete="off"
                value={price}
                aria-invalid={problem !== null || undefined}
                onChange={(event) => setPrice(event.target.value)}
              />
            </label>
            {problem ? <p className="nf-error">{copy.t(problem === 'empty' ? 'priceEmpty' : 'priceInvalid')}</p> : null}
          </fieldset>
          <div className="nf-address__actions">
            <Button type="submit" size={32} disabled={locked || watchable.length === 0}>
              {copy.t('followReview')}
            </Button>
          </div>
        </form>
      )}
      <div aria-live="polite" data-testid="alerts-follow-notice">
        {note ? (
          <p className={`nf-banner${note.tone === 'ok' ? ' nf-banner--ok' : ''}`} role="status">
            {note.text}
          </p>
        ) : null}
      </div>
      {rules.status === 'failed' ? <p className="nf-muted">{copy.t('followRulesFailed')}</p> : null}
      {rules.status === 'ready' && rules.items.length > 0 ? (
        <>
          <h3 className="nf-h2">{copy.t('followRules')}</h3>
          <ul className="nf-list" data-testid="alerts-follow-rules">
            {rules.items.map((rule) => (
              <li key={rule.id} className="nf-alertrow" data-testid="follow-rule" data-status={rule.status}>
                <div>
                  <span className="nf-title">{rule.listName}</span>
                  <span className="nf-body" lang="zxx">
                    {copy.t('followRuleLine', {
                      condition: copy.t(CONDITION_KEY[rule.condition]),
                      price: rule.targetPrice,
                      markets: rule.markets.map((marketId) => labelOf.get(marketId) ?? marketId).join(', '),
                    })}
                  </span>
                  {rule.status === 'active' && rule.lastSyncCode ? (
                    <span className="nf-body nf-body--wrap" data-testid="follow-rule-reason">
                      {copy.t(rule.lastSyncCode in SYNC_KEY ? SYNC_KEY[rule.lastSyncCode as keyof typeof SYNC_KEY] : 'followSyncUnknown')}
                    </span>
                  ) : null}
                  <span className="nf-muted">
                    {rule.lastSyncAt ? copy.t('followLastCheck', { when: stamp(rule.lastSyncAt) }) : copy.t('followNotChecked')}
                  </span>
                </div>
                <div className="nf-alertside">
                  <span className={`nf-pill${rule.status === 'active' ? ' nf-pill--ok' : ''}`}>
                    {copy.t(rule.status === 'active' ? 'followActive' : 'followEnded')}
                  </span>
                  {rule.status === 'active' ? (
                    <Button variant="secondary" size={32} disabled={busy} onClick={() => void stop(rule)}>
                      {copy.t('followStop', { list: rule.listName })}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
