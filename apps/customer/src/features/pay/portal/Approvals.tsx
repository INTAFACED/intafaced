import { useState } from 'react';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, EmptyState, Field } from '../../../shared/ui';
import { PayTime, PaySection, ReviewedAction } from '../components';
import { Chip, Facts, HaltBanner, Kpi, KpiGrid, Money, PortalFailure, PortalLoading, ReadAt, SelectField, SpanText } from './components';
import { portalCopy } from './copy';
import { useReadAt, useUrlParam } from './hooks';
import { approvalSummary, decisionBlock, matchesSearch, minReasonOk, roleMayDecide, shortId, type RoleLike } from './model';
import type { PortalApi } from './api';
import { approvalStatuses, type Approval, type HaltStatus } from './schemas';

export const payoutHref = (settlementId: string) => `/pay/payouts/${encodeURIComponent(settlementId)}`;

/**
 * `/pay/approvals`: payout requests waiting on a second person. Everything on this page is read for your own account by the
 * service; the buttons only ask. The service checks again that you are not the person who asked, that your role may decide,
 * and that the request still matches what was reviewed.
 */
export function Approvals({ portal, merchantId, role }: { portal: PortalApi; merchantId: string; role: RoleLike }) {
  const [status, setStatus] = useUrlParam('status', 'pending');
  const [q, setQ] = useUrlParam('q', '');
  const list = useResource((s) => portal.approvals(merchantId, '', s), `portal:approvals:${merchantId}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `portal:halts:${merchantId}`);
  const loadedAt = useReadAt(list.resource.status === 'ready', list.resource);
  return (
    <ApprovalsView
      portal={portal}
      list={list.resource}
      halts={halts.resource}
      loadedAt={loadedAt}
      now={loadedAt ? Date.parse(loadedAt) : Date.now()}
      me={portal.userId}
      role={role}
      status={status}
      setStatus={setStatus}
      q={q}
      setQ={setQ}
      reload={() => {
        list.reload();
        halts.reload();
      }}
    />
  );
}

export function ApprovalsView({
  portal,
  list,
  halts,
  loadedAt,
  now,
  me,
  role,
  status,
  setStatus,
  q,
  setQ,
  reload,
}: {
  portal: PortalApi;
  list: Resource<Approval[]>;
  halts: Resource<HaltStatus>;
  loadedAt: string | null;
  now: number;
  me: string | null;
  role: RoleLike;
  status: string;
  setStatus: (value: string) => void;
  q: string;
  setQ: (value: string) => void;
  reload: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const all = list.status === 'ready' ? list.data : [];
  const sum = approvalSummary(all, me, now);
  const shown = all
    .filter(
      (a) => (status === 'all' || !status ? true : a.status === status) && matchesSearch([a.settlementId, a.approvalId, a.makerUserId], q),
    )
    .sort((a, b) =>
      a.status === 'pending' && b.status === 'pending'
        ? Date.parse(a.createdAt) - Date.parse(b.createdAt)
        : a.status === 'pending'
          ? -1
          : b.status === 'pending'
            ? 1
            : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  return (
    <div className="stack">
      <HaltBanner resource={halts} scopes={['payout']} />
      <PaySection title={t('approvalsKpiTitle')} description={t('approvalsKpiBody')}>
        {list.status === 'loading' ? (
          <PortalLoading rows={2} />
        ) : list.status === 'failed' ? (
          <PortalFailure result={list.failure} retry={reload} />
        ) : (
          <>
            <ReadAt at={loadedAt} />
            <KpiGrid label={t('approvalsKpiTitle')}>
              <Kpi
                label={t('kpiWaitingDecision')}
                value={sum.waiting}
                href="/pay/approvals?status=pending"
                tone={sum.waiting > 0 ? 'attention' : undefined}
              />
              <Kpi
                label={t('kpiForYou')}
                value={roleMayDecide(role) ? sum.forOthers : '—'}
                note={roleMayDecide(role) ? t('kpiForYouNote') : t('kpiForYouRole')}
              />
              <Kpi label={t('kpiYourRequests')} value={sum.mine} note={t('kpiYourRequestsNote')} />
              <Kpi
                label={t('kpiOldest')}
                value={sum.oldest ? <SpanText ms={now - Date.parse(sum.oldest.createdAt)} /> : '—'}
                note={sum.oldest ? undefined : t('kpiOldestNone')}
              />
              <Kpi
                label={t('kpiNextExpiry')}
                value={sum.next ? <SpanText ms={Date.parse(sum.next.expiresAt) - now} /> : '—'}
                note={sum.next ? t('kpiNextExpiryNote') : t('kpiNextExpiryNone')}
              />
            </KpiGrid>
          </>
        )}
      </PaySection>

      <PaySection title={t('approvalsTitle')} description={t('approvalsBody')}>
        <div className="pp-filter-row" role="search" aria-label={t('approvalsFilters')}>
          <SelectField
            label={t('filterStatus')}
            value={status || 'pending'}
            onChange={setStatus}
            options={[
              ['all', t('filterAll')],
              ...approvalStatuses.map((s) => [s, t(`chipApproval_${s}` as 'chipApproval_pending')] as const),
            ]}
          />
          <Field
            label={t('searchApprovals')}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={200}
            hint={t('searchApprovalsHint')}
          />
        </div>
        {list.status === 'ready' &&
          (shown.length === 0 ? (
            <EmptyState
              title={
                all.length === 0
                  ? t('approvalsEmptyTitle')
                  : status === 'pending' && !q
                    ? t('approvalsNonePendingTitle')
                    : t('approvalsNoMatchTitle')
              }
              action={
                all.length > 0 && (status !== 'all' || q) ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setStatus('all');
                      setQ('');
                    }}
                  >
                    {t('showAllRequests')}
                  </Button>
                ) : (
                  <a className="text-link" href="/pay/notifications">
                    {t('approvalsNotify')}
                  </a>
                )
              }
            >
              {all.length === 0
                ? t('approvalsEmptyBody')
                : status === 'pending' && !q
                  ? t('approvalsNonePendingBody')
                  : t('approvalsNoMatchBody')}
            </EmptyState>
          ) : (
            <ul className="pp-approvals" aria-label={t('approvalsTitle')}>
              {shown.map((a) => (
                <ApprovalCard key={a.approvalId} portal={portal} approval={a} me={me} role={role} now={now} onDone={reload} />
              ))}
            </ul>
          ))}
        {list.status === 'ready' && all.length >= 200 && <p className="muted pp-note">{t('approvalsCapped')}</p>}
        <p className="muted pp-note">
          <a className="text-link" href="/pay/notifications">
            {t('approvalsNotify')}
          </a>
        </p>
      </PaySection>
    </div>
  );
}

export function ApprovalCard({
  portal,
  approval: a,
  me,
  role,
  now,
  onDone,
}: {
  portal: PortalApi;
  approval: Approval;
  me: string | null;
  role: RoleLike;
  now: number;
  onDone: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const age = now - Date.parse(a.createdAt);
  const left = Date.parse(a.expiresAt) - now;
  return (
    <li className="pp-approval">
      <div className="pp-approval-head">
        <strong className="pp-approval-amount">
          <Money value={a.amount} asset={a.assetCode} />
        </strong>
        <Chip kind="approval" value={a.status} />
        {a.status === 'pending' && (
          <>
            <span className="pp-agechip" title={t('ageTip')}>
              {t('ageWaiting')} <SpanText ms={age} />
            </span>
            <span className="pp-agechip" title={t('expiryTip')}>
              {left > 0 ? (
                <>
                  {t('expiresIn')} <SpanText ms={left} />
                </>
              ) : (
                t('expiredWaitingSweep')
              )}
            </span>
          </>
        )}
      </div>
      <Facts
        items={[
          [
            t('colPayout'),
            <a className="text-link pp-mono" href={payoutHref(a.settlementId)}>
              {shortId(a.settlementId)}
            </a>,
          ],
          [t('requestedBy'), a.makerUserId === me ? t('you') : <span className="pp-mono">{a.makerUserId}</span>],
          [t('colRequested'), <PayTime value={a.createdAt} />],
          ...(a.decidedAt && a.checkerUserId
            ? ([
                [t('decidedBy'), `${a.checkerUserId === me ? t('you') : a.checkerUserId}`],
                [t('colDecided'), <PayTime value={a.decidedAt} />],
              ] as const)
            : []),
          [
            t('fingerprint'),
            <span className="pp-mono pp-copy" title={a.payloadHash}>
              {a.payloadHash.slice(0, 19)}…
            </span>,
          ],
        ]}
      />
      {a.status === 'pending' && <ApprovalDecision portal={portal} approval={a} me={me} role={role} now={now} onDone={onDone} />}
    </li>
  );
}

/** Approve or reject one request. The reason is required and is kept with the decision. */
export function ApprovalDecision({
  portal,
  approval,
  me,
  role,
  now,
  onDone,
}: {
  portal: PortalApi;
  approval: Approval;
  me: string | null;
  role: RoleLike;
  now: number;
  onDone: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const [reason, setReason] = useState('');
  const block = decisionBlock(approval, me, role, now);
  const reasonOk = minReasonOk(reason);
  const why = block ? t(`block_${block}` as 'block_own') : reasonOk ? null : t('reasonNeeded');
  const disabled = block !== null || !reasonOk;
  const review = (verb: string) => (
    <Facts
      items={[
        [t('decisionVerb'), verb],
        [t('colAmount'), <Money value={approval.amount} asset={approval.assetCode} />],
        [t('colPayout'), <span className="pp-mono">{approval.settlementId}</span>],
        [t('requestedBy'), approval.makerUserId === me ? t('you') : <span className="pp-mono">{approval.makerUserId}</span>],
        [t('fingerprint'), <span className="pp-mono">{approval.payloadHash}</span>],
        [t('decisionReason'), reason.trim()],
      ]}
    />
  );
  return (
    <div className="form-stack pp-form pp-decision">
      <label className="field">
        <span>{t('decisionReason')} *</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} disabled={block !== null} />
        <small>{t('hDecisionReason')}</small>
      </label>
      <div className="pp-actions">
        <ReviewedAction
          title={t('approve')}
          variant="primary"
          description={t('approveBody')}
          review={review(t('approve'))}
          perform={() =>
            portal.decideApproval({
              approvalId: approval.approvalId,
              decision: 'approve',
              expectedPayloadHash: approval.payloadHash,
              reason: reason.trim(),
            })
          }
          onConfirmed={onDone}
          disabled={disabled}
        />
        <ReviewedAction
          title={t('reject')}
          variant="danger"
          description={t('rejectBody')}
          review={review(t('reject'))}
          perform={() =>
            portal.decideApproval({
              approvalId: approval.approvalId,
              decision: 'reject',
              expectedPayloadHash: approval.payloadHash,
              reason: reason.trim(),
            })
          }
          onConfirmed={onDone}
          disabled={disabled}
        />
      </div>
      {why && (
        <p className="muted pp-note" role="note">
          {why}
        </p>
      )}
    </div>
  );
}

/** The person who asked can take the request back while it is still waiting. */
export function CancelRequest({
  portal,
  approval,
  me,
  onDone,
}: {
  portal: PortalApi;
  approval: Approval;
  me: string | null;
  onDone: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const [reason, setReason] = useState('');
  const mine = me !== null && approval.makerUserId === me;
  if (approval.status !== 'pending') return null;
  return (
    <div className="form-stack pp-form">
      <label className="field">
        <span>{t('cancelReason')} *</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} disabled={!mine} />
        <small>{t('hDecisionReason')}</small>
      </label>
      <ReviewedAction
        title={t('cancelRequest')}
        description={t('cancelRequestBody')}
        review={
          <Facts
            items={[
              [t('colAmount'), <Money value={approval.amount} asset={approval.assetCode} />],
              [t('cancelReason'), reason.trim()],
            ]}
          />
        }
        perform={() => portal.cancelApproval({ approvalId: approval.approvalId, reason: reason.trim() })}
        onConfirmed={onDone}
        disabled={!mine || !minReasonOk(reason)}
      />
      {!mine && (
        <p className="muted pp-note" role="note">
          {t('cancelOnlyMaker')}
        </p>
      )}
    </div>
  );
}
