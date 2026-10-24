'use client';

import type { PublishApproval } from '@/lib/notify/incidents-model';

/**
 * The four-eyes publish controls the notify desks share: ask identity for the approval a publish spends, approve another
 * founder's request, and publish as the founder who asked. svc-notify refuses the approver publishing, so the approver
 * is offered no Publish button.
 */

export type Submit = (body: Record<string, unknown>) => void;

/** What one publish spends an approval on: a notice draft or a postmortem, with the ops and ids the desk posts for it. */
export type PublishTarget = {
  readonly ops: { readonly request: string; readonly approve: string; readonly publish: string };
  readonly ids: Readonly<Record<string, string>>;
  readonly testid: string;
};

export const noticeTarget = (id: string, testid = 'incident-approval'): PublishTarget => ({
  ops: { request: 'request', approve: 'approve', publish: 'publish' },
  ids: { noticeId: id },
  testid,
});

export const postmortemPublish = (incidentId: string): PublishTarget => ({
  ops: { request: 'request-postmortem', approve: 'approve-postmortem', publish: 'publish-postmortem' },
  ids: { incidentId },
  testid: 'postmortem-approval',
});

export function ApprovalActions({
  target,
  approval,
  me,
  busy,
  onSubmit,
}: {
  target: PublishTarget;
  approval: PublishApproval | null;
  me: string;
  busy: boolean;
  onSubmit: Submit;
}) {
  const { ops, ids, testid } = target;
  const live = approval && (approval.status === 'PENDING' || approval.status === 'APPROVED') ? approval : null;
  if (!live)
    return (
      <div className="dk-row">
        {approval && <span className="dk-muted">The last approval is {approval.status.toLowerCase()}.</span>}
        <button type="button" className="adm-btn" onClick={() => onSubmit({ op: ops.request, ...ids })} disabled={busy}>
          Ask for approval
        </button>
      </div>
    );
  const askedBy = live.requesterId === me ? 'you' : 'another founder';
  if (live.status === 'PENDING')
    return (
      <div className="dk-row" data-testid={testid} data-status="PENDING" data-approval-id={live.approvalId}>
        <span className="dk-muted">Waiting for a founder other than the one who asked (asked by {askedBy}).</span>
        <button
          type="button"
          className="adm-btn"
          onClick={() => onSubmit({ op: ops.approve, ...ids, approvalId: live.approvalId })}
          disabled={busy}
        >
          Approve
        </button>
      </div>
    );
  if (live.approverId === me)
    return (
      <div className="dk-row" data-testid={testid} data-status="APPROVED" data-approval-id={live.approvalId}>
        <span className="dk-muted">Approved by you. The founder who asked publishes it: svc-notify refuses the approver.</span>
      </div>
    );
  return (
    <div
      className="dk-row"
      data-testid={testid}
      data-status="APPROVED"
      data-approval-id={live.approvalId}
      data-operation-id={live.operationId}
    >
      <span className="dk-muted">Approved by another founder. Publishing spends the approval once.</span>
      <button
        type="button"
        className="adm-btn"
        onClick={() => onSubmit({ op: ops.publish, ...ids, approvalId: live.approvalId, operationId: live.operationId })}
        disabled={busy}
      >
        Publish
      </button>
    </div>
  );
}
