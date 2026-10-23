'use client';

import { useEffect, useRef, useState } from 'react';
import type { SupportMergePreview, SupportTicket } from '@intafaced/contracts';
import { fetchMergePreview, postSupportAction, type ActionReply, type MergePreviewReply } from '@/lib/support/browser';
import {
  MERGE_REASON_MAX,
  MERGE_REFUSAL_WORDS,
  emptyMergeForm,
  mergeConsequence,
  mergeGate,
  mergeTargetGate,
  type MergeForm,
} from '@/lib/support/merge';
import { shortId } from '@/lib/desk/desk-model';
import { ActionOutcome, ConfirmStep } from './support-action-parts';

/**
 * MERGE A DUPLICATE — fold this request into the one that stays.
 *
 * Irreversible: the messages and files move under the surviving request and this one is closed with a link to it. So the
 * panel reads what would move before it offers the button, says plainly that it cannot be undone, and sends only after a
 * second click. Both requests must be open, pending or on hold and belong to the same customer; svc-support is the judge of
 * that and its refusal is shown as it answered. A reason is required and is kept in the log of both requests.
 */

const MERGEABLE = ['open', 'pending', 'on_hold'];

export interface TicketMergeViewProps {
  readonly ticket: Pick<SupportTicket, 'id' | 'status' | 'mergedInto'>;
  readonly form: MergeForm;
  readonly preview: MergePreviewReply | null;
  readonly reading: boolean;
  readonly armed: boolean;
  readonly busy: boolean;
  readonly outcome: ActionReply | null;
  readonly onField: (patch: Partial<MergeForm>) => void;
  readonly onRead: () => void;
  readonly onArm: (on: boolean) => void;
  readonly onSend: () => void;
}

export function TicketMergeView(p: TicketMergeViewProps) {
  const t = p.ticket;
  const read = p.preview?.ok ? p.preview.preview : null;
  const gate = mergeGate(t.id, p.form, read, p.busy);
  const target = mergeTargetGate(t.id, p.form);
  const locked = p.busy || p.armed;

  if (t.mergedInto) {
    return (
      <section className="dk-stack" aria-label="Merge a duplicate" data-testid="ticket-merge">
        <h4>Merged</h4>
        <p data-testid="merge-done">
          This request was merged into <span className="dk-packet">{shortId(t.mergedInto)}</span>. Its messages and files are there now, and
          this request stays closed.
        </p>
      </section>
    );
  }

  return (
    <section className="dk-stack" aria-label="Merge a duplicate" data-testid="ticket-merge">
      <h4>Merge as a duplicate</h4>
      <p className="dk-muted">
        Fold this request into another one of the same customer. Its messages and files move under the request that stays, and this one is
        closed. It cannot be undone.
      </p>
      {!MERGEABLE.includes(t.status) ? (
        <p className="dk-why" data-testid="merge-not-mergeable">
          This request is {t.status}. Only open, pending or on-hold requests can be merged.
        </p>
      ) : (
        <>
          <div className="adm-field">
            <label htmlFor="sd-merge-survivor">The request that stays (full ticket id)</label>
            <input
              id="sd-merge-survivor"
              className="adm-input"
              value={p.form.survivorId}
              autoComplete="off"
              spellCheck={false}
              disabled={locked}
              onChange={(e) => p.onField({ survivorId: e.target.value })}
            />
          </div>
          <div className="adm-field">
            <label htmlFor="sd-merge-reason">Reason (required, kept in the log of both requests)</label>
            <input
              id="sd-merge-reason"
              className="adm-input"
              value={p.form.reason}
              maxLength={MERGE_REASON_MAX}
              autoComplete="off"
              disabled={locked}
              onChange={(e) => p.onField({ reason: e.target.value })}
            />
          </div>
          <div className="dk-row">
            <button type="button" className="adm-btn" disabled={!target.ok || locked || p.reading} onClick={p.onRead}>
              {p.reading ? 'Reading…' : 'See what would move'}
            </button>
            {!target.ok && p.form.survivorId !== '' && <span className="dk-why">{target.why}</span>}
          </div>

          <PreviewBody preview={p.preview} />

          {p.armed ? (
            <ConfirmStep
              title="Merge these requests? This cannot be undone."
              consequence={read ? mergeConsequence(read) : 'This cannot be undone.'}
              confirmLabel="Yes, merge them"
              busy={p.busy}
              onConfirm={p.onSend}
              onCancel={() => p.onArm(false)}
            />
          ) : (
            <div className="dk-row">
              <button type="button" className="adm-btn" data-tone="primary" disabled={!gate.ok} onClick={() => p.onArm(true)}>
                Review the merge
              </button>
              {!gate.ok && <span className="dk-why">{gate.why}</span>}
            </div>
          )}
        </>
      )}
      <ActionOutcome reply={p.outcome} testId="merge-outcome" />
    </section>
  );
}

function PreviewBody({ preview }: { preview: MergePreviewReply | null }) {
  if (!preview) return null;
  if (!preview.ok) {
    return (
      <div className="adm-callout" data-tone="warn" data-testid="merge-preview-failed">
        <strong>{preview.refusal ? preview.refusal.title : 'svc-support could not be read'}</strong>
        <p>{preview.refusal ? preview.refusal.body : 'Nothing is shown rather than a guess. Try again.'}</p>
      </div>
    );
  }
  return <PreviewRead preview={preview.preview} />;
}

function PreviewRead({ preview }: { preview: SupportMergePreview }) {
  if (preview.refusal !== null) {
    return (
      <div className="adm-callout" data-tone="warn" data-testid="merge-preview-refused">
        <strong>svc-support would refuse this merge</strong>
        <p>{MERGE_REFUSAL_WORDS[preview.refusal] ?? preview.refusal}</p>
        <p className="dk-muted">Nothing has changed.</p>
      </div>
    );
  }
  return (
    <dl className="dk-kv" data-testid="merge-preview">
      <dt>Messages that move</dt>
      <dd data-testid="merge-comments">{preview.commentsToMove}</dd>
      <dt>Files that move</dt>
      <dd data-testid="merge-files">{preview.attachmentsToMove}</dd>
      <dt>Stays on this request</dt>
      <dd>
        {[preview.staysOnSource.rating ? 'its rating' : null, preview.staysOnSource.caseFile ? 'its case file' : null]
          .filter((v): v is string => v !== null)
          .join(' and ') || 'Nothing: it has no rating or case file.'}
      </dd>
      {preview.alreadyMerged && (
        <>
          <dt>State</dt>
          <dd data-testid="merge-already">Already merged. Sending again returns the stored result and moves nothing.</dd>
        </>
      )}
    </dl>
  );
}

export function TicketMerge({ ticket, onDone }: { ticket: SupportTicket; onDone?: () => void }) {
  const [form, setForm] = useState<MergeForm>(emptyMergeForm);
  const [preview, setPreview] = useState<MergePreviewReply | null>(null);
  const [reading, setReading] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionReply | null>(null);
  const lock = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    setForm(emptyMergeForm);
    setPreview(null);
    setArmed(false);
    setOutcome(null);
  }, [ticket.id]);

  async function read() {
    const survivorId = form.survivorId.trim();
    if (!mergeTargetGate(ticket.id, form).ok) return;
    const mine = ++seq.current;
    setReading(true);
    const next = await fetchMergePreview(ticket.id, survivorId);
    if (mine === seq.current) {
      setPreview(next);
      setReading(false);
    }
  }

  async function send() {
    const read = preview?.ok ? preview.preview : null;
    if (lock.current || !armed || !mergeGate(ticket.id, form, read, false).ok) return;
    lock.current = true;
    setBusy(true);
    try {
      // The key is (source, survivor): a retry of this same step cannot merge twice, and svc-support returns the stored result.
      const reply = await postSupportAction({
        action: 'merge',
        ticketId: ticket.id,
        survivorId: form.survivorId.trim(),
        reason: form.reason.trim(),
      });
      setOutcome(reply);
      setArmed(false);
      // Whatever the answer, read the desk again: after "outcome not known" the page must show what is true.
      onDone?.();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <TicketMergeView
      ticket={ticket}
      form={form}
      preview={preview}
      reading={reading}
      armed={armed}
      busy={busy}
      outcome={outcome}
      onField={(patch) => {
        // A different target or reason is a different decision: the preview read earlier no longer describes it.
        if ('survivorId' in patch) setPreview(null);
        setForm((f) => ({ ...f, ...patch }));
      }}
      onRead={() => void read()}
      onArm={(on) => {
        if (!busy) setArmed(on);
      }}
      onSend={() => void send()}
    />
  );
}
