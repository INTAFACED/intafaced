import type { ReactNode } from 'react';
import type { Part } from '@/lib/desk/part';
import type { ActionReply } from '@/lib/support/browser';
import { SUPPORT_OPS_FORBIDDEN } from '@/lib/support/refusal';

/** Small pieces shared by the support desk's ticket actions and its help-article panel. */

export function Failed({ name, part }: { name: string; part: Extract<Part<unknown>, { kind: 'failed' }> }) {
  return (
    <div className="adm-callout" data-tone={part.forbidden ? 'warn' : 'danger'} role="status" data-testid="support-failed">
      <strong>{name} unavailable</strong>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
    </div>
  );
}

/** What svc-support said back to a write. A success is only ever the service's own sentence; a refusal says whether anything changed. */
export function ActionOutcome({ reply, testId, children }: { reply: ActionReply | null; testId: string; children?: ReactNode }) {
  if (!reply) return null;
  if (reply.ok) {
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid={testId}>
        <strong>Done</strong>
        <p>{reply.summary}</p>
      </div>
    );
  }
  const r = reply.refusal;
  return (
    <div
      className="adm-callout"
      role="alert"
      data-testid={testId}
      data-code={r.code ?? undefined}
      data-tone={r.title === SUPPORT_OPS_FORBIDDEN ? 'warn' : r.changed === 'unknown' ? 'warn' : 'danger'}
    >
      <strong>{r.title}</strong>
      <p>{r.body}</p>
      <p>{r.next}</p>
      {children}
    </div>
  );
}

/** The second click. Nothing is sent until "yes" is pressed; the button is off while a send is in progress. */
export function ConfirmStep({
  title,
  consequence,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  consequence: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="adm-callout" data-tone="warn" data-testid="confirm-step">
      <strong>{title}</strong>
      <p>{consequence}</p>
      {children}
      <div className="dk-row">
        <button type="button" className="adm-btn" data-tone="primary" onClick={onConfirm} disabled={busy}>
          {busy ? 'Sending…' : confirmLabel}
        </button>
        <button type="button" className="adm-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
