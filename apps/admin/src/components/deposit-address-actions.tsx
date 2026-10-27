'use client';

import { useEffect, useRef, useState } from 'react';
import { StepReplyView } from '@/components/approval-workbench';
import { ControlDesk } from '@/components/control-desk';
import { REASON_MAX, REASON_MIN, UUID, validReason } from '@/lib/desk/approval-packet';
import { readStepReply, type StepReply } from '@/lib/desk/approval-types';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { rowText } from '@/lib/ops-desk/actions-model';
import type { Row } from '@/lib/ops-desk/types';
import './desk.css';

/**
 * Freeze or lift the freeze on one customer deposit address (J-wallet-03 #4, W-compliance-notices-03).
 *
 * A freeze is one founder with a reason: svc-pay holds every deposit to the address that is not credited yet and posts nothing.
 * Lifting it credits what was held, so it is the two-founder door: you ask, a different founder approves that freeze on their
 * console, and you run it. svc-pay spends the approval once and refuses its approver as the one who runs it.
 */

const NOT_SENT = (body: string): StepReply => ({
  ok: false,
  step: 'execute',
  refusal: { title: 'Nothing was sent', body, next: 'Sign in again if needed, then repeat the step.', code: null, changed: 'no' },
});

async function postFreeze(body: { userId: string; networkId: string; address: string; reason: string }): Promise<StepReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return NOT_SENT(error instanceof Error ? error.message : 'Your founder session could not be confirmed.');
  }
  try {
    const res = await fetch('/api/accounts/deposit-freeze', {
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
    // Sent, no answer: a second freeze of the same address is refused as already frozen, so sending again is safe.
    return {
      ok: false,
      step: 'execute',
      refusal: {
        title: 'The outcome is not known',
        body: 'The connection ended before the console answered, so it is not known whether the address was frozen.',
        next: 'Read the addresses again. Sending the same freeze again is safe: an address already frozen is refused, never frozen twice.',
        code: null,
        changed: 'unknown',
      },
    };
  }
}

export function DepositAddressActions({ row, userId, onChanged }: { row: Row; userId: string; onChanged: () => void }) {
  const customer = rowText(row, 'userId');
  const networkId = rowText(row, 'networkId');
  const address = rowText(row, 'address');
  const freezeId = rowText(row, 'freezeId');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<StepReply | null>(null);
  // The freeze the lift desk is for. It stays after the list is read again without it, so the desk keeps its reply (the
  // credit count) instead of vanishing with the freeze.
  const [lifting, setLifting] = useState<string | null>(freezeId);
  useEffect(() => {
    if (freezeId !== null) setLifting(freezeId);
  }, [freezeId]);
  const lock = useRef(false);
  if (customer === null || !UUID.test(customer) || networkId === null || address === null) {
    return (
      <p className="dk-muted" data-testid="deposit-address-no-action">
        svc-pay gave this address without its customer, network or address, so it cannot be frozen from here.
      </p>
    );
  }
  const desk =
    lifting === null ? null : (
      <div className="dk-stack" data-testid="deposit-address-unfreeze">
        {freezeId === null && <p className="dk-muted">This freeze is lifted. Its request stays below with what svc-pay answered.</p>}
        <ControlDesk
          key={lifting}
          endpoint="/api/accounts/deposit-unfreeze"
          userId={userId}
          blockedReason={null}
          action={{
            heading: 'Lift the freeze on this deposit address',
            submitLabel: 'Ask a second founder to approve lifting the freeze',
            needsReason: true,
            reasonLabel: `Why (kept with the freeze, ${REASON_MIN} to ${REASON_MAX} characters)`,
            build: (why) => ({
              kind: 'pay.deposit_address.unfreeze',
              userId: customer,
              networkId,
              address,
              freezeId: lifting,
              reason: why,
            }),
          }}
          consequence="Each deposit the freeze held is judged again like any deposit and, when it is due, credited once under the same key as any deposit; one still short of its confirmations waits for them. Two different founders must agree: you ask here, a different founder pastes the packet on their own console and approves it, and then you run it. svc-pay refuses the approving founder as the one who runs it, and that attempt spends the approval, so the founder who asked runs it."
          blockedButtonLabel="Lifting unavailable"
          onChanged={onChanged}
        />
      </div>
    );
  const freezeReply = reply && (
    <div data-testid="deposit-address-freeze-reply">
      <StepReplyView reply={reply} />
    </div>
  );
  const trimmed = reason.trim();
  const ready = validReason(trimmed) && !busy;
  async function submit() {
    if (lock.current || !validReason(trimmed) || customer === null || networkId === null || address === null) return;
    lock.current = true;
    setBusy(true);
    setReply(null);
    try {
      const result = await postFreeze({ userId: customer, networkId, address, reason: trimmed });
      setReply(result);
      if (result.ok) {
        setReason('');
        onChanged();
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  // The lift desk keeps its place in the tree whether or not the freeze still stands, so reading the list again after the lift
  // does not remount it and lose its reply.
  return (
    <div className="dk-stack">
      {desk}
      {freezeId === null && (
        <form
          className="dk-stack"
          data-testid="deposit-address-freeze"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h4>Freeze this deposit address</h4>
          <p className="dk-muted">
            Every deposit to {address} that is not credited yet goes on hold and is not credited while the freeze stands; the customer sees
            it on hold. Nothing is posted. A deposit already credited, or whose credit already started, stays as it is: to stop money
            already in the account, freeze the account under Account controls. Lifting the freeze needs a second founder.
          </p>
          <div className="adm-field">
            <label htmlFor={`deposit-freeze-reason-${row.id}`}>
              Why (kept with the freeze, {REASON_MIN} to {REASON_MAX} characters)
            </label>
            <textarea
              id={`deposit-freeze-reason-${row.id}`}
              className="adm-textarea"
              rows={3}
              value={reason}
              maxLength={REASON_MAX}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="dk-row">
            <button type="submit" className="adm-btn" data-tone="primary" disabled={!ready}>
              {busy ? 'Sending…' : 'Freeze this address'}
            </button>
            {!ready && !busy && <span className="dk-why">Give a reason of at least {REASON_MIN} characters first.</span>}
          </div>
        </form>
      )}
      {freezeReply}
    </div>
  );
}
