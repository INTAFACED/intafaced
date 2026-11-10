import { navigatorApprovalsSchema, type NavigatorApprovalRequest } from '@intafaced/contracts/agents-onchain';
import { useResource } from '../../shared/resource';
import { Failure } from '../../shared/ui';
import { useApi } from '../session/session';
import { utcTime } from '../protocol/wallet/SessionKeysPanel';
import { navigatorOnchainCopy } from './navigator-onchain-copy';

/**
 * One trade the person asked the Navigator for, held for their approval (AG-approvals-01, J-agents-19 #4). The Navigator
 * never trades unasked: nothing ran and nothing was charged. A live session key changes nothing about that, and the
 * region says so whenever one is held.
 */
export function NavigatorApprovalRequestView({ request, ceiling }: { request: NavigatorApprovalRequest; ceiling: boolean }) {
  const { t } = navigatorOnchainCopy.useCopy();
  return (
    <section aria-label={t('approvalTitle')} className="navigator-approval">
      <h4>{t('approvalTitle')}</h4>
      <RequestFacts request={request} />
      <p role="note">
        <strong>{t('ceiling')}</strong>
        {ceiling ? <> {t('approvalLive')}</> : null}
      </p>
      <p className="muted">{t('approvalNothingRan')}</p>
    </section>
  );
}

function RequestFacts({ request }: { request: NavigatorApprovalRequest }) {
  const { t } = navigatorOnchainCopy.useCopy();
  return (
    <dl>
      <dt>{t('approvalAsk')}</dt>
      <dd lang="und">{request.text}</dd>
      <dt>{t('approvalStatus')}</dt>
      <dd data-request-status={request.status}>{request.status === 'waiting' ? t('approvalWaiting') : t('approvalExpired')}</dd>
      <dt>{t('approvalExpires')}</dt>
      <dd className="numeric">{utcTime(request.expiresAt)}</dd>
    </dl>
  );
}

/** The trade asks a Navigator session holds for the person, as the service keeps them, so they survive a reload. */
export function NavigatorApprovals({ sessionId, revision = 0 }: { sessionId: string; revision?: number }) {
  const { t } = navigatorOnchainCopy.useCopy();
  const api = useApi();
  const { resource, reload } = useResource(
    (signal) => api.query('agents', 'navigator.approvals', { sessionId }, navigatorApprovalsSchema, { signal }),
    `navigator-approvals:${sessionId}:${revision}`,
  );
  return (
    <div className="navigator-approvals" data-testid="navigator-approvals">
      <h4>{t('approvalsTitle')}</h4>
      {resource.status === 'loading' ? (
        <p role="status">{t('reading')}</p>
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={reload} />
      ) : resource.data.requests.length === 0 ? (
        <p className="muted">{t('approvalsEmpty')}</p>
      ) : (
        <ul>
          {resource.data.requests.map((request) => (
            <li key={request.id} data-request-key={request.requestKey}>
              <RequestFacts request={request} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
