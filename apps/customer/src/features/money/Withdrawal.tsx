import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../../app/location';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource, type Resource } from '../../shared/resource';
import { Button, EmptyState, Failure, Field, Loading, Page } from '../../shared/ui';
import { useSession } from '../session/session';
import { amount, date, Section } from './components';
import { WithdrawForm } from './WithdrawForm';
import { allowlistCopy } from './withdrawal-allowlist-copy';
import { supportedAssetsCopy } from './supported-assets-copy';
import { approvalCopy } from './withdrawal-approval-copy';
import { withdrawalCopy } from './withdrawal-copy';
import {
  createWithdrawalReads,
  requestedWithdrawal,
  withdrawalFailureMessage,
  withdrawalIdSchema,
  type CanceledWithdrawal,
  type WithdrawalRecord,
} from './withdrawal-reads';
import './withdrawal.css';

export type WithdrawalReadContext = { current: () => boolean };
const href = (id: string) => `/uc/withdraw?withdrawalId=${encodeURIComponent(id)}`;
/** The status label: svc-pay's customer vocabulary when it sends it, else the stored value. */
const statusKey = (record: WithdrawalRecord) => (record.customerStatus ? (`s_${record.customerStatus}` as const) : record.status);
/** Still in motion: a hold sits against it. */
const inMotion = (record: WithdrawalRecord) => record.status === 'held' || record.status === 'pending';

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
      <div className="failure" role="status">
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

function List({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { hideBalances } = usePreferences();
  const { t } = withdrawalCopy.useCopy();
  const active = useHandlerCurrent(current);
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource(
    (signal) => createWithdrawalReads(api, userId, current).mine(limit, signal),
    `${userId}:withdrawals:${limit}`,
  );
  return (
    <>
      <Section
        title={t('yours')}
        description={t('window', { limit })}
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              if (active()) reload();
            }}
          >
            {t('refresh')}
          </Button>
        }
      >
        <ReadResult
          resource={resource}
          retry={() => {
            if (active()) reload();
          }}
        >
          {(records) => (
            <>
              {records.length ? (
                <>
                  <div className="withdrawal-list-labels" aria-hidden="true">
                    <span>{t('amount')}</span>
                    <span>{t('status')}</span>
                    <span>{t('rail')}</span>
                    <span>{t('created')}</span>
                    <span />
                  </div>
                  <ul className="withdrawal-list">
                    {records.map((record) => (
                      <li className="withdrawal-row" key={record.id}>
                        <div className="withdrawal-row-main">
                          <strong className="numeric" lang="und" data-withdrawal-amount>
                            {hideBalances ? `•••• ${record.assetId}` : amount(record.amount, record.assetId)}
                          </strong>
                          <span
                            className={`withdrawal-status ${inMotion(record) ? 'accent' : ''}`}
                            data-withdrawal-status={record.customerStatus}
                          >
                            {t(statusKey(record))}
                          </span>
                          <span className="withdrawal-rail" lang="und">
                            {record.rail}
                          </span>
                          <time dateTime={record.createdAt}>{date(record.createdAt)}</time>
                        </div>
                        <a
                          className="button button--secondary withdrawal-open"
                          href={href(record.id)}
                          aria-label={t('detailFor', { id: record.id })}
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
              ) : (
                <EmptyState title={t('empty')}>{t('emptyNote')}</EmptyState>
              )}
              <div className="withdrawal-window" role="status">
                <p>
                  {t('returned', { count: records.length, limit })} {t('bounded')} {records.length >= limit ? t('more') : ''}
                </p>
                {records.length >= limit && limit < 200 && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (active()) setLimit(Math.min(200, limit + 50));
                    }}
                  >
                    {t('load', { limit: Math.min(200, limit + 50) })}
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
    if (!active()) return;
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
        : shown === 'dispatching' || record.status === 'pending'
          ? t('dispatchingNote')
          : t('heldUnknownNote');
    return (
      <div className="withdrawal-cancel" data-testid="withdrawal-cancel" data-cancellable={may}>
        <p className="muted" id={`withdrawal-cancel-note-${record.id}`}>
          {note}
        </p>
        <Button
          variant="secondary"
          disabled={canceling}
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
      [t('rail'), <span lang="und">{record.rail}</span>],
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
            {inMotion(record) && <p className="muted">{t('irreversible')}</p>}
            <dl className="withdrawal-facts">
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
  return (
    <Page eyebrow={t('money')} title={t('title')} description={t('description')}>
      <div className="withdrawal-page">
        {listing && <WithdrawForm />}
        {!requested.ok ? (
          <Lookup current={current} invalid />
        ) : requested.id ? (
          <Detail id={requested.id} current={current} />
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
