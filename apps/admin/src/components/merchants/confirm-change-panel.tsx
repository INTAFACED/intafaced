'use client';

import { useState } from 'react';
import type { MerchantControlChangeResult } from '@intafaced/contracts';
import { postControl } from '@/lib/merchants/control-client';
import {
  appliedMatches,
  parseHandoff,
  summariseControlChange,
  validateReason,
  type Handoff,
  type TierView,
} from '@/lib/merchants/control-model';
import type { RefusalView } from '@/lib/merchants/registry-client';
import { RefusalBlock } from './registry-form';
import { StateBlock } from './ui';

type Done = { kind: 'confirmed' | 'declined' | 'mismatch' | 'conflict' | 'other'; result: MerchantControlChangeResult };

/**
 * Step 2 of two founders, on the SECOND founder's screen. They paste the request the first founder copied and
 * read it in words. Because the service has no read for a pending change yet, what they read here is the
 * pasted text, not a record from the service: the panel says so, and after a confirm it compares what the
 * service now holds with what was shown. The service itself refuses the founder who submitted.
 */
export function ConfirmChangePanel({ merchantId, tiers }: { merchantId: string; tiers: readonly TierView[] }) {
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalView | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const parsed = text.trim() === '' ? null : parseHandoff(text);

  async function decide(action: 'confirm' | 'decline') {
    if (busy || !parsed) return;
    const problem = validateReason(reason);
    setReasonError(problem);
    if (problem) return;
    setBusy(true);
    setRefusal(null);
    const reply = await postControl({ action, requestId: parsed.requestId, reason: reason.trim() });
    setBusy(false);
    if (!reply.ok || !reply.result) {
      if (!reply.ok) setRefusal(reply.refusal);
      return;
    }
    const { result } = reply;
    if (action === 'decline') return setDone({ kind: result.outcome === 'refused' ? 'declined' : 'other', result });
    if (result.outcome === 'changed') {
      return setDone({ kind: appliedMatches(parsed.change, result.profile) ? 'confirmed' : 'mismatch', result });
    }
    setDone({ kind: result.outcome === 'conflict' ? 'conflict' : 'other', result });
  }

  return (
    <ConfirmChangeView
      merchantId={merchantId}
      tiers={tiers}
      text={text}
      onText={(v) => {
        setText(v);
        setDone(null);
        setRefusal(null);
      }}
      parsed={parsed}
      reason={reason}
      onReason={setReason}
      reasonError={reasonError}
      busy={busy}
      refusal={refusal}
      done={done}
      onDecide={decide}
    />
  );
}

export function ConfirmChangeView({
  merchantId,
  tiers,
  text,
  onText,
  parsed,
  reason,
  onReason,
  reasonError,
  busy = false,
  refusal = null,
  done = null,
  onDecide,
}: {
  merchantId: string;
  tiers: readonly TierView[];
  text: string;
  onText?: (v: string) => void;
  parsed: Handoff | null;
  reason: string;
  onReason?: (v: string) => void;
  reasonError?: string | null;
  busy?: boolean;
  refusal?: RefusalView | null;
  done?: Done | null;
  onDecide?: (action: 'confirm' | 'decline') => void;
}) {
  const wrongMerchant = parsed !== null && parsed.merchantId !== merchantId;
  return (
    <section className="mp-subpanel" aria-labelledby="confirm-change-title">
      <h3 id="confirm-change-title" className="mp-h3">
        Confirm a change from another founder
      </h3>
      <p className="mp-muted">
        Second step of two founders. Paste the request the other founder copied, read it, then confirm or decline. You cannot confirm a
        change you submitted yourself.
      </p>
      <div className="mp-field">
        <label htmlFor="cf-handoff">Request from the other founder</label>
        <textarea
          id="cf-handoff"
          className="mp-input"
          rows={4}
          value={text}
          onChange={(e) => onText?.(e.target.value)}
          aria-describedby="cf-handoff-hint"
          spellCheck={false}
        />
        <span id="cf-handoff-hint" className="mp-hint">
          Starts with a curly bracket.
        </span>
      </div>
      {text.trim() !== '' && !parsed ? (
        <StateBlock kind="error" title="That is not a request this page understands">
          Copy the whole request again from the other founder’s waiting screen. It must include the request reference, the merchant and the
          change.
        </StateBlock>
      ) : null}
      {wrongMerchant ? (
        <StateBlock kind="error" title="That request is for a different merchant">
          Open that merchant’s Controls tab to confirm it. Nothing was sent.
        </StateBlock>
      ) : null}
      {parsed && !wrongMerchant ? (
        <div className="mp-review">
          <StateBlock kind="info" title="You are reading the pasted text, not a record from the service">
            The service cannot show you a pending change yet. Confirm only if this matches what the other founder told you they are
            changing. After you confirm, this page checks what the service now holds against what you were shown, and says so loudly if they
            differ.
          </StateBlock>
          <dl className="mp-kv mp-kv--summary mp-kv--stack">
            {summariseControlChange(parsed.change, tiers).map((row) => (
              <div key={row.key}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
            <div>
              <dt>Reason the other founder gave</dt>
              <dd>
                <bdi>{parsed.reason}</bdi>
              </dd>
            </div>
          </dl>
          <div className="mp-field">
            <label htmlFor="cf-reason">
              Your reason <span aria-hidden="true">*</span>
            </label>
            <textarea
              id="cf-reason"
              className="mp-input"
              rows={2}
              value={reason}
              onChange={(e) => onReason?.(e.target.value)}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? 'cf-reason-err' : 'cf-reason-hint'}
            />
            {reasonError ? (
              <span id="cf-reason-err" className="mp-error" role="alert">
                {reasonError}
              </span>
            ) : (
              <span id="cf-reason-hint" className="mp-hint">
                Recorded with your decision. At least 3 characters.
              </span>
            )}
          </div>
          <div className="mp-inline">
            <button type="button" className="mp-btn mp-btn--primary" onClick={() => onDecide?.('confirm')} disabled={busy}>
              {busy ? 'Working…' : 'Confirm this change'}
            </button>
            <button type="button" className="mp-btn" onClick={() => onDecide?.('decline')} disabled={busy}>
              Decline
            </button>
          </div>
        </div>
      ) : null}
      <RefusalBlock refusal={refusal} />
      {done?.kind === 'confirmed' ? (
        <StateBlock kind="success" title="Confirmed and applied">
          The service now holds exactly what you were shown. Reload this page to see it in force; it is recorded with both founders.
        </StateBlock>
      ) : null}
      {done?.kind === 'mismatch' ? (
        <StateBlock kind="error" title="Applied, but not what you were shown">
          The request on file differs from the text you pasted, and it has now been applied. Treat this as a security incident: stop, tell
          engineering and the other founder now, and do not confirm anything else from this request.
        </StateBlock>
      ) : null}
      {done?.kind === 'declined' ? (
        <StateBlock kind="info" title="Declined">
          The request is closed. Nothing was changed.
        </StateBlock>
      ) : null}
      {done?.kind === 'conflict' ? (
        <StateBlock kind="error" title="Not applied: the controls changed since the request">
          Someone changed this merchant after the other founder submitted, so the request is out of date and was closed. Nothing was
          applied. Ask the other founder to submit it again from the new values.
        </StateBlock>
      ) : null}
      {done?.kind === 'other' ? (
        <StateBlock kind="info" title="Nothing was applied">
          The service did not apply this request. Reload the page to see what is in force.
        </StateBlock>
      ) : null}
    </section>
  );
}
