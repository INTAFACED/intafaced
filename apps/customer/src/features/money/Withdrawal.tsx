import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../../app/location';
import { authoredRefusal, type ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource, type Resource } from '../../shared/resource';
import { Button, EmptyState, Failure, Field, Loading, Page } from '../../shared/ui';
import { useSession } from '../session/session';
import { amount, date, Section } from './components';
import { WithdrawForm } from './WithdrawForm';
import { asksForWallet } from './withdraw-to-wallet';
import { WalletProvider } from '../protocol/wallet/WalletProvider';
import { INTERNAL_RAIL } from './withdraw-destination';
import { allowlistCopy } from './withdrawal-allowlist-copy';
import { supportedAssetsCopy } from './supported-assets-copy';
import { useSupportedAssets } from './supported-assets-reads';
import { approvalCopy } from './withdrawal-approval-copy';
import { withdrawalCopy } from './withdrawal-copy';
import {
  createWithdrawalReads,
  requestedWithdrawal,
  WITHDRAWAL_SHOWN,
  withdrawalFailureMessage,
  withdrawalIdSchema,
  type CanceledWithdrawal,
  type ReturnedFunds,
  type WithdrawalHistoryFilter,
  type WithdrawalHistoryItem,
  type WithdrawalRecord,
  type WithdrawalShown,
} from './withdrawal-reads';
import './withdrawal.css';

export type WithdrawalReadContext = { current: () => boolean };
const href = (id: string) => `/uc/withdraw?withdrawalId=${encodeURIComponent(id)}`;
/** The status label: svc-pay's customer vocabulary when it sends it, else the stored value. */
const statusKey = (record: WithdrawalRecord) => (record.customerStatus ? (`s_${record.customerStatus}` as const) : record.status);
/** Still in motion: a hold sits against it. */
const inMotion = (record: WithdrawalRecord) => record.status === 'held' || record.status === 'pending';
/** Finished: nothing sits against it any more. Every other status is still in motion, `needs_review` included. */
const HISTORY_DONE: ReadonlySet<WithdrawalShown> = new Set<WithdrawalShown>(['settled', 'rejected', 'canceled', 'failed']);
const historyInMotion = (item: WithdrawalHistoryItem) => !HISTORY_DONE.has(item.status);

function useHandlerCurrent(current: () => boolean) {
  const rendering = {};
  const rendered = useRef(rendering);
  rendered.current = rendering;
  return () => rendered.current === rendering && current();
}

function ReadResult<T>({ resource, retry, children }: { resource: Resource<T>; retry: () => void; children: (value: T) => ReactNode }) {
  const { t } = withdrawalCopy.useCopy();
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'ready') return <>{children(resource.data)}</>;
  const result = resource.failure;
  if (result.status === 404 && result.code === 'pay.withdrawal_not_found')
    return (
      <div data-testid="failure" className="failure" role="status">
        <h3>{t('notFound')}</h3>
        <p>{t('notFoundNote')}</p>
        <Button variant="secondary" onClick={retry}>
          {t('refreshRecord')}
        </Button>
      </div>
    );
  const message = withdrawalFailureMessage(result);
  // Authored copy follows the device locale; service text remains opaque.
  const failure: Extract<ApiResult<T>, { ok: false }> = message ? { ...result, message, messageCopy: undefined } : result;
  return (
    <div lang={message || result.messageCopy ? undefined : 'und'}>
      <Failure result={failure} retry={retry} />
    </div>
  );
}

function Lookup({ current, invalid = false }: { current: () => boolean; invalid?: boolean }) {
  const { t, requestedLocale } = withdrawalCopy.useCopy();
  const active = useHandlerCurrent(current);
  const [original, setOriginal] = useState('');
  const [failed, setFailed] = useState(invalid);
  return (
    <Section title={t('find')} description={t('findNote')}>
      <form
        className="withdrawal-lookup"
        onSubmit={(event) => {
          event.preventDefault();
          if (!active()) return;
          const parsed = withdrawalIdSchema.safeParse(original);
          if (!parsed.success) {
            setFailed(true);
            return;
          }
          navigate(href(parsed.data));
        }}
      >
        <Field
          label={<span lang={requestedLocale}>{t('id')}</span>}
          value={original}
          autoComplete="off"
          spellCheck={false}
          lang="und"
          error={failed ? <span lang={requestedLocale}>{t('invalidId')}</span> : undefined}
          onChange={(event) => {
            if (active()) {
              setOriginal(event.target.value);
              setFailed(false);
            }
          }}
        />
        <Button type="submit">{t('open')}</Button>
      </form>
    </Section>
  );
}

/** Older pages the person asked for under one filter, appended below the first page. */
type Older = { key: string; items: WithdrawalHistoryItem[]; next: string | null; loading: boolean; failure: ApiFailure | null };
type ApiFailure = Extract<ApiResult<unknown>, { ok: false }>;

function List({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { hideBalances } = usePreferences();
  const { t } = withdrawalCopy.useCopy();
  const active = useHandlerCurrent(current);
  const assets = useSupportedAssets();
  const [filter, setFilter] = useState<WithdrawalHistoryFilter>({ assetId: null, status: null });
  const key = `${userId}:withdrawal-history:${filter.assetId ?? '*'}:${filter.status ?? '*'}`;
  const { resource, reload } = useResource((signal) => createWithdrawalReads(api, userId, current).history(filter, null, signal), key);
  const [older, setOlder] = useState<Older | null>(null);
  // The filter and first page the older pages belong to: a page that comes back after either changed is dropped.
  const shown = useRef({ key, resource });
  useLayoutEffect(() => {
    shown.current = { key, resource };
  });
  const first = resource.status === 'ready' ? resource.data : null;
  const extra = older && older.key === key && first ? older : null;
  const items = first ? [...first.items, ...(extra?.items ?? [])] : [];
  const next = extra ? extra.next : (first?.next ?? null);
  const filtered = filter.assetId !== null || filter.status !== null;

  function refresh() {
    if (!active()) return;
    setOlder(null);
    reload();
  }
  async function loadOlder() {
    if (!active() || !next || extra?.loading) return;
    const asked = { key, resource };
    const base = extra ?? { key, items: [], next, loading: false, failure: null };
    setOlder({ ...base, loading: true, failure: null });
    const result = await createWithdrawalReads(api, userId, current).history(filter, next, undefined);
    // `current()`, not `active()`: this render is gone by now, and the page is still this person's.
    if (!current() || shown.current.key !== asked.key || shown.current.resource !== asked.resource) return;
    const seen = new Set(items.map((item) => item.id));
    if (result.ok && result.data.items.some((item) => seen.has(item.id))) {
      setOlder({ ...base, loading: false, failure: authoredRefusal('invalid_response', { key: 'loadFailed' }) });
      return;
    }
    setOlder(
      result.ok
        ? { key, items: [...base.items, ...result.data.items], next: result.data.next, loading: false, failure: null }
        : { ...base, loading: false, failure: result },
    );
  }
  function choose(change: Partial<WithdrawalHistoryFilter>) {
    if (!active()) return;
    setOlder(null);
    setFilter({ ...filter, ...change });
  }
  const coins = assets.resource.status === 'ready' ? assets.resource.data.assets.map((asset) => asset.assetId) : [];
  return (
    <>
      <Section
        title={t('yours')}
        description={t('window')}
        actions={
          <Button variant="secondary" onClick={refresh}>
            {t('refresh')}
          </Button>
        }
      >
        <div className="withdrawal-filters" data-testid="withdrawal-filters">
          <label className="field">
            <span>{t('filterCoin')}</span>
            <select
              name="withdrawal-coin"
              value={filter.assetId ?? ''}
              onChange={(event) => choose({ assetId: event.target.value || null })}
              aria-describedby={assets.resource.status === 'failed' ? 'withdrawal-coins-unread' : undefined}
            >
              <option value="">{t('allCoins')}</option>
              {[...new Set([...coins, ...(filter.assetId ? [filter.assetId] : [])])].map((coin) => (
                <option key={coin} value={coin} lang="und">
                  {coin}
                </option>
              ))}
            </select>
            {assets.resource.status === 'failed' && <small id="withdrawal-coins-unread">{t('coinsUnread')}</small>}
          </label>
          <label className="field">
            <span>{t('status')}</span>
            <select
              name="withdrawal-status"
              value={filter.status ?? ''}
              onChange={(event) => {
                const value = WITHDRAWAL_SHOWN.find((status) => status === event.target.value) ?? null;
                choose({ status: value });
              }}
            >
              <option value="">{t('allStatuses')}</option>
              {WITHDRAWAL_SHOWN.map((status) => (
                <option key={status} value={status}>
                  {t(`s_${status}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ReadResult resource={resource} retry={refresh}>
          {() => (
            <>
              {items.length ? (
                <>
                  <div className="withdrawal-list-labels" aria-hidden="true">
                    <span>{t('amount')}</span>
                    <span>{t('status')}</span>
                    <span>{t('rail')}</span>
                    <span>{t('created')}</span>
                    <span />
                  </div>
                  <ul className="withdrawal-list" data-testid="withdrawal-history">
                    {items.map((item) => (
                      <li data-testid="withdrawal-row" className="withdrawal-row" key={item.id} data-withdrawal-id={item.id}>
                        <div className="withdrawal-row-main">
                          <strong className="numeric" lang="und" data-withdrawal-amount>
                            {hideBalances ? `•••• ${item.assetId}` : amount(item.amount, item.assetId)}
                          </strong>
                          <span
                            className={`withdrawal-status ${historyInMotion(item) ? 'accent' : ''}`}
                            data-withdrawal-status={item.status}
                          >
                            {t(`s_${item.status}`)}
                          </span>
                          <span className="withdrawal-rail" lang={item.rail === INTERNAL_RAIL ? undefined : 'und'}>
                            {item.rail === INTERNAL_RAIL ? t('rInside') : item.rail}
                          </span>
                          <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
                        </div>
                        <a
                          className="button button--secondary withdrawal-open"
                          href={href(item.id)}
                          aria-label={t('detailFor', { id: item.id })}
                          onClick={(event) => {
                            if (!active()) event.preventDefault();
                          }}
                        >
                          <span aria-hidden="true">↗</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              ) : filtered ? (
                <EmptyState title={t('emptyMatch')}>{t('emptyMatchNote')}</EmptyState>
              ) : (
                <EmptyState title={t('empty')}>{t('emptyNote')}</EmptyState>
              )}
              <div
                className="withdrawal-window"
                role="status"
                data-testid="withdrawal-window"
                data-count={items.length}
                data-more={Boolean(next)}
              >
                {items.length > 0 && (
                  <p>
                    {t('returned', { count: items.length })} {next ? t('more') : t('allShown')}
                  </p>
                )}
                {extra?.failure && (
                  // A refused cursor or an overlapping page would refuse again: start over from the newest page instead.
                  <Failure
                    result={extra.failure}
                    retry={
                      extra.failure.reason === 'invalid_response' || extra.failure.code === 'pay.withdrawal_cursor_invalid'
                        ? refresh
                        : () => void loadOlder()
                    }
                  />
                )}
                {next && !extra?.failure && (
                  <Button variant="secondary" disabled={extra?.loading} onClick={() => void loadOlder()}>
                    {extra?.loading ? <Loading /> : t('load')}
                  </Button>
                )}
              </div>
            </>
          )}
        </ReadResult>
      </Section>
      <Lookup current={current} />
    </>
  );
}

const RETURN_REASONS = ['destination_rejected', 'network_returned', 'other'] as const;

/**
 * What came back from a sent withdrawal (W-withdraw-07): the amount, why, and whether it is back in available. svc-pay says
 * whether it is credited; until a second founder approved it and the ledger booked it, the page says it is being checked.
 */
function ReturnedPart({ record, current }: { record: WithdrawalRecord; current: () => boolean }) {
  const { api, userId } = useSession();
  const { hideBalances } = usePreferences();
  const { t } = withdrawalCopy.useCopy();
  const { resource } = useResource(
    (signal) => createWithdrawalReads(api, userId, current).returnOf(record.id, signal),
    `${userId}:withdrawal-return:${record.id}`,
  );
  if (resource.status === 'loading') return null;
  if (resource.status === 'failed')
    return (
      <p className="muted" role="status" data-testid="withdrawal-returned-unread">
        {t('returnedReadFailed')}
      </p>
    );
  const back: ReturnedFunds | null = resource.data;
  if (!back) return null;
  const shown = hideBalances ? `•••• ${record.assetId}` : amount(back.amount, record.assetId);
  const code = RETURN_REASONS.find((known) => known === back.reasonCode);
  return (
    <div className="withdrawal-returned" role="status" data-testid="withdrawal-returned" data-credited={back.credited}>
      <h3>{t('returnedTitle')}</h3>
      <p data-withdrawal-amount>{t(back.credited ? 'returnedCredited' : 'returnedChecking', { amount: shown })}</p>
      <p>{t('returnedWhy', { why: code ? t(`returnReason_${code}`) : t('returnReasonUnknown') })}</p>
    </div>
  );
}

function Detail({ id, current }: { id: string; current: () => boolean }) {
  const { api, userId } = useSession();
  const { hideBalances } = usePreferences();
  const { t } = withdrawalCopy.useCopy();
  const active = useHandlerCurrent(current);
  const { resource, reload } = useResource(
    (signal) => createWithdrawalReads(api, userId, current).get(id, signal),
    `${userId}:withdrawal:${id}`,
  );
  const refresh = () => {
    if (active()) reload();
  };
  const [canceling, setCanceling] = useState(false);
  const [canceled, setCanceled] = useState<CanceledWithdrawal | null>(null);
  const [cancelFailure, setCancelFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  async function cancel() {
    if (!active() || canceling) return;
    setCanceling(true);
    setCancelFailure(null);
    const result = await createWithdrawalReads(api, userId, current).cancel(id);
    // The page re-rendered while the cancel ran (the button turned to "Cancelling…"), so this checks the page and account
    // themselves, not the render that started it.
    if (!current()) return;
    setCanceling(false);
    if (result.ok) setCanceled(result.data);
    else {
      const message = withdrawalFailureMessage(result);
      setCancelFailure(message ? { ...result, message, messageCopy: undefined } : result);
    }
    // Either way the record may have moved: read it again.
    reload();
  }
  /**
   * Cancel, on every withdrawal still in motion (W-withdraw-07). svc-pay decides: when the record says it cannot be cancelled,
   * the reason sits beside the button, and pressing it anyway answers with svc-pay's typed refusal. A finished withdrawal has
   * nothing to cancel.
   */
  function cancelPart(record: WithdrawalRecord): ReactNode {
    if (!inMotion(record)) return null;
    const shown = record.customerStatus;
    // An older svc-pay sends no `cancellable`: it cancels a requested withdrawal and refuses a held one.
    const may = record.cancellable ?? record.status === 'pending';
    const note = may
      ? t('cancelNote')
      : shown === 'broadcast' || shown === 'confirming'
        ? t('broadcastNote')
        : shown === 'dispatching'
          ? t('dispatchingNote')
          : record.status === 'pending'
            ? t('requestedSentNote')
            : t('heldUnknownNote');
    return (
      <div className="withdrawal-cancel" data-testid="withdrawal-cancel" data-cancellable={may}>
        <p className="muted" id={`withdrawal-cancel-note-${record.id}`}>
          {note}
        </p>
        <Button
          variant="secondary"
          // Off once cancelled, until the record reads back as cancelled.
          disabled={canceling || canceled !== null}
          aria-describedby={`withdrawal-cancel-note-${record.id}`}
          onClick={() => void cancel()}
        >
          {canceling ? t('canceling') : t('cancel')}
        </Button>
      </div>
    );
  }
  function facts(record: WithdrawalRecord): [string, ReactNode][] {
    return [
      [
        t('id'),
        <span lang="und" data-withdrawal-private>
          {record.id}
        </span>,
      ],
      [
        t('clientRef'),
        <span lang="und" data-withdrawal-private>
          {record.clientRef}
        </span>,
      ],
      [t('source'), t('ownSource', { asset: record.assetId })],
      [
        t('destination'),
        <span lang="und" data-withdrawal-private>
          {record.destination.kind} · {record.destination.ref}
        </span>,
      ],
      [t('rail'), record.rail === INTERNAL_RAIL ? t('rInside') : <span lang="und">{record.rail}</span>],
      [
        t('railRef'),
        record.railRef === null ? (
          t('none')
        ) : (
          <span lang="und" data-withdrawal-private>
            {record.railRef}
          </span>
        ),
      ],
      [t('attempts'), <span lang="und">{record.attempts}</span>],
      [t('failureCode'), record.failureCode === null ? t('none') : <span lang="und">{record.failureCode}</span>],
      [t('created'), <time dateTime={record.createdAt}>{date(record.createdAt)}</time>],
    ];
  }
  return (
    <Section title={t('record')}>
      <p className="withdrawal-original">
        {t('id')}:{' '}
        <span lang="und" data-withdrawal-private>
          {id}
        </span>
      </p>
      <ReadResult resource={resource} retry={refresh}>
        {(record) => (
          <div className="withdrawal-detail">
            <div className="withdrawal-detail-value">
              <strong className="numeric" lang="und" data-withdrawal-amount>
                {hideBalances ? `•••• ${record.assetId}` : amount(record.amount, record.assetId)}
              </strong>
              <span className={inMotion(record) ? 'accent' : undefined} data-testid="withdrawal-status" data-status={record.customerStatus}>
                {t(statusKey(record))}
              </span>
            </div>
            <p className="muted">{t('statusNote')}</p>
            {canceled && (
              <p role="status" data-testid="withdrawal-canceled">
                {canceled.holdReleased === true
                  ? t('canceledReleased')
                  : canceled.holdReleased === false
                    ? t('canceledNothing')
                    : t('canceledUnknown')}
              </p>
            )}
            {cancelFailure && (
              <div data-testid="withdrawal-cancel-refused">
                <Failure result={cancelFailure} retry={() => setCancelFailure(null)} />
              </div>
            )}
            {cancelPart(record)}
            {record.status === 'sent' && <ReturnedPart key={record.id} record={record} current={current} />}
            {inMotion(record) && <p className="muted">{t('irreversible')}</p>}
            <dl data-testid="withdrawal-facts" className="withdrawal-facts">
              {facts(record).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <Button variant="secondary" onClick={refresh}>
              {t('refreshRecord')}
            </Button>
          </div>
        )}
      </ReadResult>
      <a
        className="button button--secondary withdrawal-return"
        href="/uc/withdraw"
        onClick={(event) => {
          if (!active()) event.preventDefault();
        }}
      >
        {t('viewAll')}
      </a>
    </Section>
  );
}

export function Withdrawal({ context, search }: { context: WithdrawalReadContext; search: string }) {
  const { t } = withdrawalCopy.useCopy();
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && context.current();
  const requested = requestedWithdrawal(search);
  if (!context.current()) return <p role="status">{t('changed')}</p>;
  // The address bar names no withdrawal: this is the Withdraw page itself. The form leads; records and Find sit below it.
  const listing = requested.ok && !requested.id;
  const toWallet = listing && asksForWallet(search);
  return (
    <Page eyebrow={t('money')} title={t('title')} description={t('description')}>
      <div className="withdrawal-page">
        {listing &&
          (toWallet ? (
            // The browser wallet's connection, mounted here only when the page is asked to fill from it.
            <WalletProvider>
              <WithdrawForm toWallet />
            </WalletProvider>
          ) : (
            <WithdrawForm />
          ))}
        {!requested.ok ? (
          <Lookup current={current} invalid />
        ) : requested.id ? (
          <Detail key={requested.id} id={requested.id} current={current} />
        ) : (
          <List current={current} />
        )}
        {listing && (
          <p>
            <a className="text-link" href="/uc/withdraw/approvals">
              {approvalCopy.t('title')} ↗
            </a>{' '}
            <a className="text-link" href="/uc/withdraw/allowlist">
              {allowlistCopy.t('title')} ↗
            </a>{' '}
            <a className="text-link" href="/uc/assets">
              {supportedAssetsCopy.t('linkLabel')} ↗
            </a>
          </p>
        )}
        {listing ? (
          <p>
            <a className="text-link withdrawal-back" href="/portfolio">
              {t('back')} ↗
            </a>
          </p>
        ) : (
          <Section title={t('unavailable')} description={t('unavailableNote')}>
            <a className="text-link withdrawal-back" href="/portfolio">
              {t('back')} ↗
            </a>
          </Section>
        )}
      </div>
    </Page>
  );
}
