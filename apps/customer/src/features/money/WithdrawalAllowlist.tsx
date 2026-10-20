import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource, type Resource } from '../../shared/resource';
import { Button, EmptyState, Failure, Loading, Page } from '../../shared/ui';
import { useSession } from '../session/session';
import { amount, date, Section } from './components';
import { allowlistCopy } from './withdrawal-allowlist-copy';
import { createAllowlistReads, requestedChange, type AllowlistChange } from './withdrawal-allowlist-reads';
import './withdrawal.css';

export type AllowlistReadContext = { current: () => boolean };
const href = (id: string) => `/uc/withdraw/allowlist?changeId=${encodeURIComponent(id)}`;

function useHandlerCurrent(current: () => boolean) {
  const rendering = {};
  const rendered = useRef(rendering);
  rendered.current = rendering;
  return () => rendered.current === rendering && current();
}

const failureKeys: Record<string, 'invalidId' | 'invalidWindow' | 'signedOut'> = {
  'allowlist.input_invalid': 'invalidId',
  'allowlist.window_invalid': 'invalidWindow',
  'allowlist.session_required': 'signedOut',
};

function ReadResult<T>({ resource, retry, children }: { resource: Resource<T>; retry: () => void; children: (value: T) => ReactNode }) {
  const { t } = allowlistCopy.useCopy();
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'ready') return <>{children(resource.data)}</>;
  const result = resource.failure;
  if (result.status === 404 || result.code === 'allowlist.not_found')
    return (
      <div className="failure" role="status">
        <h3>{t('notFound')}</h3>
        <p>{t('notFoundNote')}</p>
        <Button variant="secondary" onClick={retry}>
          {t('refreshRecord')}
        </Button>
      </div>
    );
  const key = result.code ? failureKeys[result.code] : undefined;
  const failure: Extract<ApiResult<T>, { ok: false }> = key ? { ...result, message: t(key), messageCopy: undefined } : result;
  return (
    <div lang={key || result.messageCopy ? undefined : 'und'}>
      <Failure result={failure} retry={retry} />
    </div>
  );
}

const tone = (status: AllowlistChange['status']) => (status === 'waiting' || status === 'approved' ? 'accent' : '');

function Mode({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const active = useHandlerCurrent(current);
  const { resource, reload } = useResource((signal) => createAllowlistReads(api, userId, current).mode(signal), `${userId}:allowlist-mode`);
  return (
    <Section title={t('modeTitle')} description={t('modeNote')}>
      <ReadResult
        resource={resource}
        retry={() => {
          if (active()) reload();
        }}
      >
        {(mode) => (
          <>
            <p role="status" data-testid="allowlist-mode">
              <strong>{mode.enabled ? t('modeOn') : t('modeOff')}</strong>{' '}
              <span className="muted">{mode.setAt ? t('modeSince', { when: date(mode.setAt) }) : t('modeNever')}</span>
            </p>
            <div className="withdrawal-actions">
              <Button disabled aria-describedby="allowlist-change-blocked">
                {mode.enabled ? t('turnOff') : t('turnOn')}
              </Button>
            </div>
            <p id="allowlist-change-blocked" className="muted">
              {t('changeBlocked')}
            </p>
          </>
        )}
      </ReadResult>
    </Section>
  );
}

function Entries({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const active = useHandlerCurrent(current);
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource(
    (signal) => createAllowlistReads(api, userId, current).entries(limit, signal),
    `${userId}:allowlist-entries:${limit}`,
  );
  return (
    <Section
      title={t('entriesTitle')}
      description={t('entriesWindow', { limit })}
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
        {(entries) => (
          <>
            {entries.length ? (
              <ul className="withdrawal-list" data-testid="allowlist-entries">
                {entries.map((entry) => (
                  <li className="withdrawal-row" key={entry.id}>
                    <div className="withdrawal-row-main">
                      <strong>{entry.label}</strong>
                      <span className="numeric" lang="und" data-withdrawal-private>
                        {entry.address}
                      </span>
                      <span>
                        {t(entry.group)} · <span lang="und">{entry.assetId}</span>
                      </span>
                      <span className={`withdrawal-status ${entry.state === 'active' ? 'accent' : ''}`}>{t(entry.state as 'active')}</span>
                      <span>{entry.lastUsedAt ? <time dateTime={entry.lastUsedAt}>{date(entry.lastUsedAt)}</time> : t('never')}</span>
                    </div>
                    {entry.state === 'suspended' && <p className="muted">{t('suspendedNote')}</p>}
                    <Button variant="secondary" disabled aria-describedby="allowlist-change-blocked">
                      {t('remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t('entriesEmpty')}>{t('entriesEmptyNote')}</EmptyState>
            )}
            <div className="withdrawal-actions">
              <Button disabled aria-describedby="allowlist-change-blocked">
                {t('add')}
              </Button>
            </div>
            <div className="withdrawal-window" role="status">
              <p>
                {t('returned', { count: entries.length, limit })} {entries.length >= limit ? t('more') : ''}
              </p>
              {entries.length >= limit && limit < 200 && (
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
  );
}

function OneTime({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const active = useHandlerCurrent(current);
  const { resource, reload } = useResource(
    (signal) => createAllowlistReads(api, userId, current).policy(signal),
    `${userId}:allowlist-policy`,
  );
  return (
    <Section title={t('oneTimeTitle')} description={t('oneTimeNote')}>
      <ReadResult
        resource={resource}
        retry={() => {
          if (active()) reload();
        }}
      >
        {(policy) => (
          <>
            <p role="status" data-testid="allowlist-policy">
              {policy.enabled && policy.maxAmount && policy.assetId
                ? t('oneTimeOn', { max: amount(policy.maxAmount, policy.assetId) })
                : t('oneTimeOff')}
            </p>
            <div className="withdrawal-actions">
              <Button variant="secondary" disabled aria-describedby="allowlist-change-blocked">
                {t('oneTimeChange')}
              </Button>
            </div>
          </>
        )}
      </ReadResult>
    </Section>
  );
}

function subjectOf(change: AllowlistChange): ReactNode {
  const s = change.subject as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  if (change.op === 'add' || change.op === 'delete')
    return (
      <span lang="und" data-withdrawal-private>
        {text(s.label)} · {text(s.address)} · {text(s.assetId)}
      </span>
    );
  if (change.op === 'onetime_policy')
    return (
      <span lang="und">
        {s.enabled === true ? 'on' : 'off'} · {text(s.maxAmount)} {text(s.assetId)}
      </span>
    );
  return null;
}

function Changes({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const active = useHandlerCurrent(current);
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource(
    (signal) => createAllowlistReads(api, userId, current).changes(limit, signal),
    `${userId}:allowlist-changes:${limit}`,
  );
  return (
    <Section title={t('changesTitle')} description={t('entriesWindow', { limit })}>
      <ReadResult
        resource={resource}
        retry={() => {
          if (active()) reload();
        }}
      >
        {(changes) =>
          changes.length ? (
            <ul className="withdrawal-list" data-testid="allowlist-changes">
              {changes.map((change) => (
                <li className="withdrawal-row" key={change.id}>
                  <div className="withdrawal-row-main">
                    <strong>{t(`${change.op}_op` as 'add_op')}</strong>
                    {subjectOf(change)}
                    <span className={`withdrawal-status ${tone(change.status)}`}>{t(change.status)}</span>
                    <span className="numeric">{t('tally', { count: change.approvalCount, required: change.requiredApprovals })}</span>
                  </div>
                  <a
                    className="button button--secondary withdrawal-open"
                    href={href(change.id)}
                    aria-label={t('openChange', { id: change.id })}
                    onClick={(event) => {
                      if (!active()) event.preventDefault();
                    }}
                  >
                    <span aria-hidden="true">↗</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t('changesEmpty')}>{t('changesEmptyNote')}</EmptyState>
          )
        }
      </ReadResult>
    </Section>
  );
}

function Detail({ id, current }: { id: string; current: () => boolean }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const active = useHandlerCurrent(current);
  const { resource, reload } = useResource(
    (signal) => createAllowlistReads(api, userId, current).get(id, signal),
    `${userId}:allowlist-change:${id}`,
  );
  const [canceling, setCanceling] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const refresh = () => {
    if (active()) reload();
  };
  async function cancel(change: AllowlistChange) {
    if (!active() || canceling) return;
    setCanceling(true);
    setFailure(null);
    const result = await createAllowlistReads(api, userId, current).cancel(change.id);
    if (!active()) return;
    setCanceling(false);
    if (result.ok) {
      setCancelled(true);
      reload();
    } else setFailure(result);
  }
  return (
    <Section title={t('record')}>
      <ReadResult resource={resource} retry={refresh}>
        {(change) => {
          const own = change.userId === userId;
          const facts: [string, ReactNode][] = [
            [t('id'), <span lang="und">{change.id}</span>],
            [
              t('subject'),
              <>
                {t(`${change.op}_op` as 'add_op')} {subjectOf(change)}
              </>,
            ],
            [t('hash'), <span lang="und">{change.requestHash}</span>],
            [t('submitted'), <time dateTime={change.createdAt}>{date(change.createdAt)}</time>],
            [t('decided'), change.decidedAt === null ? t('none') : <time dateTime={change.decidedAt}>{date(change.decidedAt)}</time>],
            [t('failureCode'), change.failureCode === null ? t('none') : <span lang="und">{change.failureCode}</span>],
          ];
          return (
            <div className="withdrawal-detail">
              <div className="withdrawal-detail-value">
                <span className={tone(change.status)}>{t(change.status)}</span>
                <span className="numeric">{t('tally', { count: change.approvalCount, required: change.requiredApprovals })}</span>
              </div>
              <p className="muted">{t('hashNote')}</p>
              <dl className="withdrawal-facts">
                {facts.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {cancelled && <p role="status">{t('cancelled2')}</p>}
              {failure && <Failure result={failure} retry={() => setFailure(null)} />}
              <div className="withdrawal-actions">
                <Button variant="secondary" onClick={refresh}>
                  {t('refreshRecord')}
                </Button>
                {own && (
                  <Button variant="secondary" disabled={change.status !== 'waiting' || canceling} onClick={() => void cancel(change)}>
                    {canceling ? t('canceling') : t('cancel')}
                  </Button>
                )}
              </div>
              {own && <p className="muted">{t('cancelHint')}</p>}
            </div>
          );
        }}
      </ReadResult>
      <a
        className="button button--secondary withdrawal-return"
        href="/uc/withdraw/allowlist"
        onClick={(event) => {
          if (!active()) event.preventDefault();
        }}
      >
        {t('viewAll')}
      </a>
    </Section>
  );
}

/** `/uc/withdraw/allowlist`: the caller's address list, its mode, the one-time setting and its changes; one change when `?changeId=` names it. */
export function WithdrawalAllowlist({ context, search }: { context: AllowlistReadContext; search: string }) {
  const { t } = allowlistCopy.useCopy();
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && context.current();
  const requested = requestedChange(search);
  if (!context.current()) return <p role="status">{t('changed')}</p>;
  return (
    <Page eyebrow={t('money')} title={t('title')} description={t('description')}>
      <div className="withdrawal-page">
        {!requested.ok ? (
          <p className="failure" role="alert">
            {t('invalidId')}
          </p>
        ) : requested.id ? (
          <Detail id={requested.id} current={current} />
        ) : (
          <>
            <Mode current={current} />
            <Entries current={current} />
            <OneTime current={current} />
            <Changes current={current} />
          </>
        )}
        <p>
          <a className="text-link withdrawal-back" href="/uc/withdraw">
            {t('viewWithdrawals')} ↗
          </a>
        </p>
      </div>
    </Page>
  );
}
