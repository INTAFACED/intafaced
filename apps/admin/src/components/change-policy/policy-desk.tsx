'use client';

import { useCallback, useRef, useState } from 'react';
import {
  isConsoleSettablePolicyActionType,
  type ActionApprovalPolicyEntry,
  type ConsoleSettablePolicyActionType,
} from '@intafaced/contracts/action-approval-policy';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import type { Part } from '@/lib/desk/part';
import { ChangePolicyRoom } from './room';
import '../desk.css';

/**
 * Setting one governed type's approval row (J-ops-console-09 #1). The four values go to svc-identity as typed: a blank or
 * unreadable one makes the row unset, and identity then refuses every request of that type until a whole row is set.
 * Two founders must agree: one asks, a different founder approves the exact row, then it is written.
 */

export interface PolicyRowsDeskView {
  readonly asOf: string;
  readonly policies: Part<readonly ActionApprovalPolicyEntry[]>;
}

async function fetchRows(): Promise<PolicyRowsDeskView | null> {
  try {
    const res = await fetch('/api/identity-ops/policy', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()) as PolicyRowsDeskView;
    return body && typeof body.asOf === 'string' && body.policies ? body : null;
  } catch {
    return null;
  }
}

function valuesOf(entry: ActionApprovalPolicyEntry | undefined) {
  if (!entry || entry.state !== 'set') return { requiredApprovals: '', approverAudience: '', applier: '', maxAgeSeconds: '' };
  const p = entry.policy;
  return {
    requiredApprovals: String(p.requiredApprovals),
    approverAudience: p.approverAudience,
    applier: p.applier,
    maxAgeSeconds: String(p.maxAgeSeconds),
  };
}

function PolicyRowControls({
  entries,
  userId,
  onChanged,
}: {
  entries: readonly ActionApprovalPolicyEntry[];
  userId: string;
  onChanged: () => void;
}) {
  const [actionType, setActionType] = useState<ConsoleSettablePolicyActionType>(entries[0]!.actionType as ConsoleSettablePolicyActionType);
  const entry = entries.find((e) => e.actionType === actionType);
  const [values, setValues] = useState(() => valuesOf(entry));
  const set = (key: keyof typeof values) => (v: string) => setValues((old) => ({ ...old, [key]: v }));
  const expectedVersion = entry?.rowVersion ?? '0';

  const action: ControlAction = {
    heading: `Set the approval policy for ${actionType}`,
    submitLabel: 'Ask a second founder to approve this policy',
    needsReason: false,
    reasonLabel: '',
    build: () => ({
      kind: 'identity.approval_policy.set',
      actionType,
      requiredApprovals: values.requiredApprovals.trim(),
      approverAudience: values.approverAudience.trim(),
      applier: values.applier.trim(),
      maxAgeSeconds: values.maxAgeSeconds.trim(),
      expectedVersion,
    }),
    danger: true,
  };

  return (
    <ControlDesk
      key={`${actionType}:${expectedVersion}`}
      endpoint="/api/identity-ops/policy"
      userId={userId}
      blockedReason={null}
      action={action}
      consequence="Requests of this type are judged by the new row from the moment it is written; requests already asked under the old row are refused. A blank value leaves the row unset, and then nothing of this type can be asked, approved or applied. Two different founders must agree."
      blockedButtonLabel="Policy change unavailable"
      onChanged={onChanged}
    >
      <div className="adm-field">
        <label htmlFor="pd-type">Action</label>
        <select
          id="pd-type"
          className="adm-input"
          value={actionType}
          onChange={(e) => {
            const next = e.target.value as ConsoleSettablePolicyActionType;
            setActionType(next);
            setValues(valuesOf(entries.find((x) => x.actionType === next)));
          }}
        >
          {entries.map((e) => (
            <option key={e.actionType} value={e.actionType}>
              {e.actionType}
            </option>
          ))}
        </select>
      </div>
      <div className="adm-field">
        <label htmlFor="pd-count">Approvals needed, other than the requester</label>
        <input
          id="pd-count"
          className="adm-input"
          inputMode="numeric"
          value={values.requiredApprovals}
          onChange={(e) => set('requiredApprovals')(e.target.value)}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="pd-audience">Who may approve</label>
        <select
          id="pd-audience"
          className="adm-input"
          value={values.approverAudience}
          onChange={(e) => set('approverAudience')(e.target.value)}
        >
          <option value="">Not set</option>
          <option value="founder">Founders</option>
          <option value="operator">Operators</option>
          <option value="trade_ops">Trade operators</option>
        </select>
      </div>
      <div className="adm-field">
        <label htmlFor="pd-applier">Applied only by (service)</label>
        <input id="pd-applier" className="adm-input" value={values.applier} onChange={(e) => set('applier')(e.target.value)} />
      </div>
      <div className="adm-field">
        <label htmlFor="pd-age">Longest life of a request, in seconds</label>
        <input
          id="pd-age"
          className="adm-input"
          inputMode="numeric"
          value={values.maxAgeSeconds}
          onChange={(e) => set('maxAgeSeconds')(e.target.value)}
        />
      </div>
    </ControlDesk>
  );
}

export function ChangePolicyDesk({ initial, userId }: { initial: PolicyRowsDeskView; userId: string }) {
  const [view, setView] = useState<PolicyRowsDeskView | null>(initial);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetchRows();
    if (mine === sequence.current) {
      setView(next);
      setLoading(false);
    }
  }, []);
  const entries = view && view.policies.kind === 'ok' ? view.policies.data : null;
  // Only the staff changes are set here; the ledger correction rows move money and stay the deployment owner's.
  const settable = entries ? entries.filter((e) => isConsoleSettablePolicyActionType(e.actionType)) : null;
  return (
    <div className="dk-stack" data-testid="change-policy-desk">
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void reload()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {view ? (
        <ChangePolicyRoom asOf={view.asOf} policies={view.policies} />
      ) : (
        <p className="dk-why">svc-identity could not be read. Nothing is shown rather than a guess.</p>
      )}
      {settable && settable.length > 0 && <PolicyRowControls entries={settable} userId={userId} onChanged={() => void reload()} />}
    </div>
  );
}
