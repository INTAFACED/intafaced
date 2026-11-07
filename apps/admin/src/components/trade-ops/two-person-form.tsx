'use client';

import { useState, type ReactNode } from 'react';
import type { ActionApproval } from '@intafaced/contracts';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';

type Proposed = { approval: ActionApproval; payloadHash: string; expectedVersion: string };
export type Refusal = { code: string; message: string };

export function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputMode?: 'numeric' | 'decimal';
  type?: 'text' | 'date';
  wide?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 text-sm${props.wide ? ' min-w-[20rem] flex-1' : ''}`}>
      <span>{props.label}</span>
      <input
        className="adm-input"
        aria-label={props.label}
        type={props.type ?? 'text'}
        inputMode={props.inputMode}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * One versioned two-person write (J-cex-spot-20 #8): the fields, a check run here with svc-trade's own rule (a blank is
 * refused by name and nothing is filed), the filed request with its approval id and payload hash, and the write once a
 * second founder has approved exactly that.
 */
export function TwoPersonForm(props: {
  room: string;
  label: string;
  proposeLabel: string;
  applyLabel: string;
  confirmTitle: string;
  confirmLabel: string;
  consequence: string;
  /** The refusal the values would get, or null when they can be filed. */
  check: () => Refusal | null;
  proposeBody: () => Record<string, unknown>;
  applyBody: (approvalId: string) => Record<string, unknown>;
  canApply: boolean;
  children: ReactNode;
}) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [proposed, setProposed] = useState<Outcome<Proposed> | null>(null);
  const [approvalId, setApprovalId] = useState('');
  const [busy, setBusy] = useState(false);

  async function propose() {
    setProposed(null);
    const refused = props.check();
    setRefusal(refused);
    if (refused) return;
    setBusy(true);
    setProposed(await tradeOpsAction<Proposed>(props.room, props.proposeBody()));
    setBusy(false);
  }

  return (
    <form
      aria-label={props.label}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void propose();
      }}
    >
      {props.children}
      <div>
        <button type="submit" className="adm-btn" data-tone="primary" disabled={busy}>
          {props.proposeLabel}
        </button>
      </div>
      {refusal ? (
        <div role="alert" className="flex flex-col gap-1 text-sm" data-refused={refusal.code}>
          <span>
            Refused <code className="if-num text-xs">{refusal.code}</code>
          </span>
          <span className="text-fg-2">{refusal.message} Nothing was filed.</span>
        </div>
      ) : null}
      {proposed ? (
        <div className="flex flex-col gap-2">
          <OutcomeNotice outcome={proposed} doneText="Request filed" />
          {proposed.kind === 'ok' ? (
            <dl data-filed="" className="grid gap-x-4 gap-y-1 text-sm md:grid-cols-[max-content_1fr]">
              <dt className="text-fg-2">Approval id</dt>
              <dd className="if-num" data-field="Approval id">
                {proposed.data.approval.approvalId}
              </dd>
              <dt className="text-fg-2">Payload hash</dt>
              <dd className="if-num" data-field="Payload hash">
                {proposed.data.payloadHash}
              </dd>
              <dt className="text-fg-2">Bound to version</dt>
              <dd className="if-num" data-field="Bound to version">
                v{proposed.data.expectedVersion}
              </dd>
            </dl>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Approved request id" value={approvalId} onChange={setApprovalId} />
        <ConfirmAction
          trigger={props.applyLabel}
          title={props.confirmTitle}
          consequence={props.consequence}
          confirmLabel={props.confirmLabel}
          reasonMin={0}
          disabled={approvalId.trim() === '' || !props.canApply}
          disabledReason="Fill the form as it was proposed and enter the approved request id."
          doneText="Written"
          run={() => tradeOpsAction(props.room, props.applyBody(approvalId.trim()))}
        />
      </div>
    </form>
  );
}
