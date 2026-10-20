import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../../app/location';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource, type Resource } from '../../shared/resource';
import { Button, EmptyState, Failure, Field, Loading, Page } from '../../shared/ui';
import { useSession } from '../session/session';
import { amount, date, Section } from './components';
import { WithdrawForm } from './WithdrawForm';
import { approvalCopy } from './withdrawal-approval-copy';
import { withdrawalCopy } from './withdrawal-copy';
import {
  createWithdrawalReads,
  requestedWithdrawal,
  withdrawalFailureMessage,
  withdrawalIdSchema,
  type WithdrawalRecord,
} from './withdrawal-reads';
import './withdrawal.css';

export type WithdrawalReadContext = { current: () => boolean };
const href = (id: string) => `/uc/withdraw?withdrawalId=${encodeURIComponent(id)}`;

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
                          <span className={`withdrawal-status ${record.status === 'held' || record.status === 'pending' ? 'accent' : ''}`}>
                            {t(record.status)}
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
              <span className={record.status === 'held' || record.status === 'pending' ? 'accent' : undefined}>{t(record.status)}</span>
            </div>
            <p className="muted">{t('statusNote')}</p>
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
