'use client';

import { useRef, useState } from 'react';
import { StepReplyView } from '@/components/approval-workbench';
import { REASON_MAX, REASON_MIN, UUID, validReason } from '@/lib/desk/approval-packet';
import { readStepReply, type StepReply } from '@/lib/desk/approval-types';
import { travelRuleSteps, type TravelRuleAction } from '@/lib/deposit-travel-rule/model';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { rowText } from '@/lib/ops-desk/actions-model';
import type { Row } from '@/lib/ops-desk/types';
import './desk.css';

/**
 * Review one deposit held for the inbound travel rule (J-wallet-03 #2-#3, W-deposit-07). One founder with a reason either records
 * a wait on the sending platform (nothing is released when it runs out) or releases a declared deposit, which svc-pay then credits
 * once under its usual key. The declared values are sealed in svc-pay and never shown here.
 */

const NOT_SENT = (body: string): StepReply => ({
  ok: false,
  step: 'execute',
  refusal: { title: 'Nothing was sent', body, next: 'Sign in again if needed, then repeat the step.', code: null, changed: 'no' },
});

async function postStep(body: { action: TravelRuleAction; depositId: string; reason: string }): Promise<StepReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return NOT_SENT(error instanceof Error ? error.message : 'Your founder session could not be confirmed.');
  }
  try {
    const res = await fetch('/api/accounts/deposit-travel-rule', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const answer: unknown = await res.json().catch(() => null);
    if ((res.status === 401 || res.status === 403) && !(answer && typeof answer === 'object' && 'refusal' in answer))
      return NOT_SENT('The console did not accept your founder session. Sign out and in again.');
    return readStepReply(answer);
  } catch {
    // Sent, no answer: a release seen twice is refused (a released deposit takes no step), so reading again shows what happened.
    return {
      ok: false,
      step: 'execute',
      refusal: {
        title: 'The outcome is not known',
        body: 'The connection ended before the console answered, so it is not known whether svc-pay recorded the step.',
        next: 'Read the deposits again. A released deposit is credited once whatever is sent again: a second release is refused.',
        code: null,
        changed: 'unknown',
      },
    };
  }
}

export function DepositTravelRuleActions({ row, onChanged }: { row: Row; onChanged: () => void }) {
  const depositId = rowText(row, 'depositId');
  const state = rowText(row, 'state');
  const declared = rowText(row, 'declaredAt') !== null;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<TravelRuleAction | null>(null);
  const [reply, setReply] = useState<StepReply | null>(null);
  const lock = useRef(false);
  if (depositId === null || !UUID.test(depositId)) {
    return (
      <p className="dk-muted" data-testid="deposit-travel-rule-no-action">
        svc-pay gave this deposit without its id, so it cannot be reviewed from here.
      </p>
    );
  }
  const steps = travelRuleSteps(state, declared);
  const trimmed = reason.trim();
  async function run(action: TravelRuleAction) {
    if (lock.current || !validReason(trimmed) || depositId === null) return;
    lock.current = true;
    setBusy(action);
    setReply(null);
    try {
      const result = await postStep({ action, depositId, reason: trimmed });
      setReply(result);
      if (result.ok) {
        setReason('');
        onChanged();
      }
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }
  const replyView = reply && (
    <div data-testid="deposit-travel-rule-reply">
      <StepReplyView reply={reply} />
    </div>
  );
  if (!steps.wait && !steps.release) {
    return (
      <div className="dk-stack">
        {replyView}
        <p className="dk-muted" data-testid="deposit-travel-rule-closed">
          {state === 'released'
            ? 'Released: svc-pay credits this deposit once, and it takes no further step.'
            : state === 'counterparty_pending'
              ? 'Waiting on the sending platform, and the depositor has not declared yet. Release needs their declaration.'
              : 'This deposit takes no step from here in its present state.'}
        </p>
      </div>
    );
  }
  const ready = validReason(trimmed) && busy === null;
  return (
    <div className="dk-stack">
      <form className="dk-stack" data-testid="deposit-travel-rule-review" onSubmit={(e) => e.preventDefault()}>
        <h4>Review this held deposit</h4>
        <p className="dk-muted">
          {declared
            ? 'The depositor declared where it came from; the values are sealed in svc-pay and not shown here.'
            : 'The depositor has not declared yet, so it cannot be released.'}{' '}
          Waiting on the sending platform keeps it held for the owner’s pending wait limit, and when that runs out it stays held. Releasing
          it lets svc-pay credit it once under the same key as any deposit.
        </p>
        <div className="adm-field">
          <label htmlFor={`deposit-travel-rule-reason-${row.id}`}>
            Why (kept on the deposit’s travel-rule history, {REASON_MIN} to {REASON_MAX} characters)
          </label>
          <textarea
            id={`deposit-travel-rule-reason-${row.id}`}
            className="adm-textarea"
            rows={3}
            value={reason}
            maxLength={REASON_MAX}
            disabled={busy !== null}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="dk-row">
          {steps.release && (
            <button type="button" className="adm-btn" data-tone="primary" disabled={!ready} onClick={() => void run('release')}>
              {busy === 'release' ? 'Sending…' : 'Release and credit once'}
            </button>
          )}
          {steps.wait && (
            <button type="button" className="adm-btn" disabled={!ready} onClick={() => void run('wait')}>
              {busy === 'wait' ? 'Sending…' : 'Wait on the sending platform'}
            </button>
          )}
          {!ready && busy === null && <span className="dk-why">Give a reason of at least {REASON_MIN} characters first.</span>}
        </div>
      </form>
      {replyView}
    </div>
  );
}
