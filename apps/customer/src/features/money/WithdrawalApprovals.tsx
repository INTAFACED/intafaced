import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource, type Resource } from '../../shared/resource';
import { Button, EmptyState, Failure, Loading, Page } from '../../shared/ui';
import { useSession } from '../session/session';
import { amount, date, Section } from './components';
import { approvalCopy } from './withdrawal-approval-copy';
import { createApprovalReads, requestedApproval, type ApprovalRequest } from './withdrawal-approval-reads';
import './withdrawal.css';

export type ApprovalReadContext = { current: () => boolean };
const href = (id: string) => `/uc/withdraw/approvals?requestId=${encodeURIComponent(id)}`;

function useHandlerCurrent(current: () => boolean) {
  const rendering = {};
  const rendered = useRef(rendering);
  rendered.current = rendering;
  return () => rendered.current === rendering && current();
}

const failureKeys: Record<string, 'invalidId' | 'invalidWindow' | 'signedOut'> = {
  'withdrawal_approval.input_invalid': 'invalidId',
  'withdrawal_approval.window_invalid': 'invalidWindow',
  'withdrawal_approval.session_required': 'signedOut',
};

function ReadResult<T>({ resource, retry, children }: { resource: Resource<T>; retry: () => void; children: (value: T) => ReactNode }) {
  const { t } = approvalCopy.useCopy();
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'ready') return <>{children(resource.data)}</>;
  const result = resource.failure;
  if (result.status === 404 || result.code === 'withdrawal_approval.not_found')
    return (
      <div data-testid="failure" className="failure" role="status">
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

const tone = (status: ApprovalRequest['status']) => (status === 'pending' || status === 'approved' ? 'accent' : '');

function List({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { hideBalances } = usePreferences();
  const { t } = approvalCopy.useCopy();
  const active = useHandlerCurrent(current);
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource(
    (signal) => createApprovalReads(api, userId, current).mine(limit, signal),
    `${userId}:withdrawal-approvals:${limit}`,
  );
  return (
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
        {(requests) => (
          <>
            {requests.length ? (
              <>
                <div className="withdrawal-list-labels" aria-hidden="true">
                  <span>{t('amount')}</span>
                  <span>{t('status')}</span>
                  <span>{t('progress')}</span>
                  <span>{t('expires')}</span>
                  <span />
                </div>
                <ul className="withdrawal-list" data-testid="approval-list">
                  {requests.map((request) => (
                    <li data-testid="withdrawal-row" className="withdrawal-row" key={request.id}>
                      <div className="withdrawal-row-main">
                        <strong className="numeric" lang="und" data-withdrawal-amount>
                          {hideBalances ? `•••• ${request.assetId}` : amount(request.amount, request.assetId)}
                        </strong>
                        <span className={`withdrawal-status ${tone(request.status)}`}>{t(request.status)}</span>
                        <span className="numeric">{t('tally', { count: request.approvalCount, required: request.requiredApprovals })}</span>
                        <time dateTime={request.expiresAt}>{date(request.expiresAt)}</time>
                      </div>
                      <a
                        data-testid="withdrawal-open"
                        className="button button--secondary withdrawal-open"
                        href={href(request.id)}
                        aria-label={t('openRequest', { id: request.id })}
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
                {t('returned', { count: requests.length, limit })} {requests.length >= limit ? t('more') : ''}
              </p>
              {requests.length >= limit && limit < 200 && (
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

function Decision({ request }: { request: ApprovalRequest }) {
  const { t } = approvalCopy.useCopy();
  return (
    <Section title={t('decideTitle')} description={t('decideNote')}>
      {request.approvedByMe && <p role="status">{t('youApproved')}</p>}
      <div className="withdrawal-actions">
        <Button disabled aria-describedby="approval-decide-blocked">
          {t('approve')}
        </Button>
        <Button variant="secondary" disabled aria-describedby="approval-decide-blocked">
          {t('reject')}
        </Button>
      </div>
      <p id="approval-decide-blocked" className="muted">
        {t('decideBlocked')}
      </p>
    </Section>
  );
}

function Detail({ id, current }: { id: string; current: () => boolean }) {
  const { api, userId } = useSession();
  const { hideBalances } = usePreferences();
  const { t } = approvalCopy.useCopy();
  const active = useHandlerCurrent(current);
  const { resource, reload } = useResource(
    (signal) => createApprovalReads(api, userId, current).get(id, signal),
    `${userId}:withdrawal-approval:${id}`,
  );
  const [canceling, setCanceling] = useState(false);
  const [cancelFailure, setCancelFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [canceled, setCanceled] = useState(false);
  const refresh = () => {
    if (active()) reload();
  };
  async function cancel(request: ApprovalRequest) {
    if (!active() || canceling) return;
    setCanceling(true);
    setCancelFailure(null);
    const result = await createApprovalReads(api, userId, current).cancel(request.id);
    if (!active()) return;
    setCanceling(false);
    if (result.ok) {
      setCanceled(true);
      reload();
    } else setCancelFailure(result);
  }
  function facts(request: ApprovalRequest): [string, ReactNode][] {
    return [
      [
        t('id'),
        <span lang="und" data-withdrawal-private>
          {request.id}
        </span>,
      ],
      [
        t('clientRef'),
        <span lang="und" data-withdrawal-private>
          {request.clientRef}
        </span>,
      ],
      [t('source'), t('ownSource', { asset: request.assetId })],
      [
        t('destination'),
        <span lang="und" data-withdrawal-private>
          {request.destination.kind} · {request.destination.ref}
        </span>,
      ],
      [t('rail'), <span lang="und">{request.rail}</span>],
      [t('hold'), request.holdAtSubmit ? t('holdPlaced') : t('holdLater')],
      [t('expires'), <time dateTime={request.expiresAt}>{date(request.expiresAt)}</time>],
      [t('created'), <time dateTime={request.createdAt}>{date(request.createdAt)}</time>],
      [t('decided'), request.decidedAt === null ? t('none') : <time dateTime={request.decidedAt}>{date(request.decidedAt)}</time>],
      [t('failureCode'), request.failureCode === null ? t('none') : <span lang="und">{request.failureCode}</span>],
    ];
  }
  return (
    <>
      <Section title={t('record')}>
        <ReadResult resource={resource} retry={refresh}>
          {(request) => {
            const own = request.userId === userId;
            return (
              <div data-testid="withdrawal-detail" className="withdrawal-detail">
                <div className="withdrawal-detail-value">
                  <strong className="numeric" lang="und" data-withdrawal-amount>
                    {hideBalances ? `•••• ${request.assetId}` : amount(request.amount, request.assetId)}
                  </strong>
                  <span className={tone(request.status)}>{t(request.status)}</span>
                  <span className="numeric">{t('tally', { count: request.approvalCount, required: request.requiredApprovals })}</span>
                </div>
                <p className="muted">{t('statusNote')}</p>
                <dl data-testid="withdrawal-facts" className="withdrawal-facts">
                  {facts(request).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                {canceled && <p role="status">{t('canceled2')}</p>}
                {cancelFailure && <Failure result={cancelFailure} retry={() => setCancelFailure(null)} />}
                <div className="withdrawal-actions">
                  <Button variant="secondary" onClick={refresh}>
                    {t('refreshRecord')}
                  </Button>
                  {own && (
                    <Button variant="secondary" disabled={request.status !== 'pending' || canceling} onClick={() => void cancel(request)}>
                      {canceling ? t('canceling') : t('cancel')}
                    </Button>
                  )}
                </div>
                {own && <p className="muted">{t('cancelHint')}</p>}
                {!own && request.status === 'pending' && <Decision request={request} />}
              </div>
            );
          }}
        </ReadResult>
        <a
          className="button button--secondary withdrawal-return"
          href="/uc/withdraw/approvals"
          onClick={(event) => {
            if (!active()) event.preventDefault();
          }}
        >
          {t('viewAll')}
        </a>
      </Section>
    </>
  );
}

/** `/uc/withdraw/approvals`: the caller's own approval requests, and one request when `?requestId=` names it. */
export function WithdrawalApprovals({ context, search }: { context: ApprovalReadContext; search: string }) {
  const { t } = approvalCopy.useCopy();
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && context.current();
  const requested = requestedApproval(search);
  if (!context.current()) return <p role="status">{t('changed')}</p>;
  return (
    <Page eyebrow={t('money')} title={t('title')} description={t('description')}>
      <div data-testid="withdrawal-page" className="withdrawal-page">
        {!requested.ok ? (
          <p data-testid="failure" className="failure" role="alert">
            {t('invalidId')}
          </p>
        ) : requested.id ? (
          <Detail id={requested.id} current={current} />
        ) : (
          <List current={current} />
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
