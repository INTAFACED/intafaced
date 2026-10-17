'use client';

import { useState } from 'react';
import type { PayoutApproval } from '@intafaced/contracts';
import { postControl } from '@/lib/merchants/control-client';
import { validateReason } from '@/lib/merchants/control-model';
import type { RefusalView } from '@/lib/merchants/registry-client';
import { RefusalBlock } from './registry-form';
import { StateBlock } from './ui';

type Mode = 'closed' | 'review' | 'confirm' | 'done';

export interface DecisionSubject {
  readonly approvalId: string;
  readonly payloadHash: string;
  /** "1,200.00 USDT" */
  readonly amountText: string;
  /** The merchant's name or, with none, its short id. Plain text. */
  readonly merchantText: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** The signed-in founder asked for, or approved on the merchant side, this payout. */
  readonly tookPart: boolean;
  readonly expired: boolean;
}

/**
 * Sign one payout approval as a founder. Two different founders must each sign; the first signature leaves
 * the payout waiting. The decision is bound to the exact payout hash shown here, so if the payout changes
 * after you open it the service refuses and nothing is approved. Approve has a confirm step; both choices need a reason.
 */
export function ApprovalDecision({ subject }: { subject: DecisionSubject }) {
  const [mode, setMode] = useState<Mode>('closed');
  const [choice, setChoice] = useState<'approve' | 'reject'>('approve');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalView | null>(null);
  const [done, setDone] = useState<PayoutApproval | null>(null);

  function pick(next: 'approve' | 'reject') {
    const problem = validateReason(reason);
    setReasonError(problem);
    if (problem) return;
    setChoice(next);
    setRefusal(null);
    setMode('confirm');
  }

  async function send() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const reply = await postControl({
      action: 'decide',
      approvalId: subject.approvalId,
      decision: choice,
      expectedPayloadHash: subject.payloadHash,
      reason: reason.trim(),
    });
    setBusy(false);
    if (!reply.ok || !reply.approval) {
      if (!reply.ok) setRefusal(reply.refusal);
      return;
    }
    setDone(reply.approval);
    setMode('done');
  }

  const disabledWhy = subject.expired
    ? 'This request ran out of time. The merchant has to ask again.'
    : subject.tookPart
      ? 'You asked for or approved this payout. A different founder must sign it.'
      : undefined;

  if (mode === 'done' && done) return <DecisionResult approval={done} choice={choice} />;

  return (
    <div className="mp-decision">
      {mode === 'closed' || mode === 'done' ? (
        <button type="button" className="mp-btn" onClick={() => setMode('review')} disabled={disabledWhy !== undefined} title={disabledWhy}>
          Review and decide
        </button>
      ) : (
        <DecisionPanel
          subject={subject}
          mode={mode}
          choice={choice}
          reason={reason}
          onReason={setReason}
          reasonError={reasonError}
          busy={busy}
          refusal={refusal}
          onPick={pick}
          onSend={send}
          onBack={() => setMode('review')}
          onClose={() => {
            setMode('closed');
            setRefusal(null);
          }}
        />
      )}
      {mode === 'closed' && disabledWhy ? <p className="mp-hint">{disabledWhy}</p> : null}
    </div>
  );
}

export function DecisionPanel({
  subject,
  mode,
  choice,
  reason,
  onReason,
  reasonError,
  busy = false,
  refusal = null,
  onPick,
  onSend,
  onBack,
  onClose,
}: {
  subject: DecisionSubject;
  mode: 'review' | 'confirm';
  choice: 'approve' | 'reject';
  reason: string;
  onReason?: (v: string) => void;
  reasonError?: string | null;
  busy?: boolean;
  refusal?: RefusalView | null;
  onPick?: (c: 'approve' | 'reject') => void;
  onSend?: () => void;
  onBack?: () => void;
  onClose?: () => void;
}) {
  const fid = `ad-${subject.approvalId}`;
  return (
    <div
      className="mp-review mp-decision__panel"
      role="group"
      aria-label={`Decide the ${subject.amountText} payout for ${subject.merchantText}`}
    >
      <dl className="mp-kv mp-kv--summary mp-kv--stack">
        <div>
          <dt>Payout</dt>
          <dd className="mp-num">{subject.amountText}</dd>
        </div>
        <div>
          <dt>Merchant</dt>
          <dd>
            <bdi>{subject.merchantText}</bdi>
          </dd>
        </div>
        <div>
          <dt>What you sign</dt>
          <dd className="mp-hash">
            This exact payout, <code>{subject.payloadHash}</code>. If amount, destination or rail change, your signature no longer applies.
          </dd>
        </div>
      </dl>
      {mode === 'review' ? (
        <>
          <div className="mp-field">
            <label htmlFor={`${fid}-reason`}>
              Your reason <span aria-hidden="true">*</span>
            </label>
            <textarea
              id={`${fid}-reason`}
              className="mp-input"
              rows={2}
              value={reason}
              onChange={(e) => onReason?.(e.target.value)}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? `${fid}-err` : `${fid}-hint`}
            />
            {reasonError ? (
              <span id={`${fid}-err`} className="mp-error" role="alert">
                {reasonError}
              </span>
            ) : (
              <span id={`${fid}-hint`} className="mp-hint">
                Recorded with your decision. At least 3 characters.
              </span>
            )}
          </div>
          <div className="mp-inline">
            <button type="button" className="mp-btn mp-btn--primary" onClick={() => onPick?.('approve')}>
              Approve…
            </button>
            <button type="button" className="mp-btn" onClick={() => onPick?.('reject')}>
              Reject…
            </button>
            <button type="button" className="mp-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <StateBlock
            kind={choice === 'approve' ? 'info' : 'error'}
            title={choice === 'approve' ? 'Confirm: approve this payout' : 'Confirm: reject this payout'}
          >
            {choice === 'approve'
              ? `You are signing a payout of ${subject.amountText} for ${subject.merchantText}. It only goes ahead when a different founder also signs. This cannot be undone.`
              : `You are rejecting the payout of ${subject.amountText} for ${subject.merchantText}. It will not go, and the merchant has to ask again. This cannot be undone.`}
          </StateBlock>
          <RefusalBlock refusal={refusal} />
          <div className="mp-inline">
            <button type="button" className="mp-btn mp-btn--primary" onClick={onSend} disabled={busy}>
              {busy ? 'Sending…' : choice === 'approve' ? 'Yes, approve' : 'Yes, reject'}
            </button>
            <button type="button" className="mp-btn" onClick={onBack} disabled={busy}>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** What the service says happened after a founder's decision. A first approval is NOT the end: the payout still waits. */
export function DecisionResult({ approval, choice }: { approval: Pick<PayoutApproval, 'status'>; choice: 'approve' | 'reject' }) {
  if (approval.status === 'approved')
    return (
      <StateBlock kind="success" title="Fully approved">
        Two founders have signed. The payout can go ahead.
      </StateBlock>
    );
  if (approval.status === 'rejected')
    return (
      <StateBlock kind="info" title="Rejected">
        The payout will not go. The merchant has to ask again.
      </StateBlock>
    );
  if (approval.status === 'pending' && choice === 'approve')
    return (
      <StateBlock kind="info" title="Waiting for a second founder">
        Your signature is recorded. The payout stays on hold until a different founder also signs it from this queue.
      </StateBlock>
    );
  return (
    <StateBlock kind="error" title={approval.status === 'voided' ? 'Voided: the payout changed' : `Not approved: ${approval.status}`}>
      {approval.status === 'voided'
        ? 'The amount or destination moved since it was requested, so the approval no longer covers it. Nothing was approved.'
        : 'The service did not approve this payout. Reload the queue to see where it stands.'}
    </StateBlock>
  );
}
