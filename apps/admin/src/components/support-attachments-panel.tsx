'use client';

import { Fragment, useCallback, useRef, useState } from 'react';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import {
  ATTACHMENT_HINT,
  ATTACHMENT_LABEL,
  ATTACHMENT_PIECE_LABEL,
  ATTACHMENT_PIECE_WHERE,
  ATTACHMENT_SETTINGS,
  REASON_MAX,
  attachmentChanges,
  attachmentDraftsFrom,
  attachmentGate,
  emptyAttachmentDrafts,
  type AttachmentDrafts,
  type AttachmentSetting,
  type AttachmentStatus,
} from '@/lib/support/attachments';
import { fetchAttachments, postAttachments, type AttachmentsDeskView, type AttachmentsReply } from '@/lib/support/attachments-browser';
import { ConfirmStep, Failed } from './support-action-parts';

/**
 * SUPPORT ATTACHMENTS — the five pieces a ticket attachment needs and the three limits the owner sets.
 *
 * Nothing is built in: a piece that is not set reads "Not set" with the key that is missing, and until every piece is set a
 * customer's attach is refused naming that key. Saving names the revision this page read, so a change by someone else is
 * refused instead of overwritten, and the page reads again after every answer. Only a staff lead can save; others read.
 * The file store and the scanner are deployment settings: shown here, never edited here.
 */

export interface AttachmentsForm {
  readonly drafts: AttachmentDrafts;
  readonly reason: string;
}

export interface AttachmentsPanelViewProps {
  readonly view: AttachmentsDeskView | null;
  readonly loading: boolean;
  readonly form: AttachmentsForm;
  readonly armed: boolean;
  readonly busy: boolean;
  readonly outcome: AttachmentsReply | null;
  readonly onDraft: (setting: AttachmentSetting, value: string) => void;
  readonly onReason: (value: string) => void;
  readonly onArm: (on: boolean) => void;
  readonly onSend: () => void;
  readonly onRefresh: () => void;
}

function Outcome({ reply }: { reply: AttachmentsReply | null }) {
  if (!reply) return null;
  if (reply.ok) {
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="attachments-outcome">
        <strong>Saved</strong>
        <p>The file limits now read revision {reply.limits.revision}.</p>
      </div>
    );
  }
  const r = reply.refusal;
  return (
    <div className="adm-callout" role="alert" data-tone={r.changed === 'unknown' ? 'warn' : 'danger'} data-testid="attachments-outcome">
      <strong>{r.title}</strong>
      <p>{r.body}</p>
      <p>{r.next}</p>
    </div>
  );
}

function currentValue(status: AttachmentStatus | null, s: AttachmentSetting): string {
  if (!status) return 'Not set';
  const v = status.limits[s];
  if (v === null) return 'Not set';
  return Array.isArray(v) ? v.join(', ') : String(v);
}

export function AttachmentsPanelView(p: AttachmentsPanelViewProps) {
  const status = p.view?.status.kind === 'ok' ? p.view.status.data : null;
  const current = status?.limits ?? null;
  const gate = current
    ? attachmentGate(current, p.form.drafts, p.form.reason, p.busy)
    : ({ ok: false, why: 'The current limits could not be read.' } as const);
  const parsed = current ? attachmentChanges(current, p.form.drafts) : null;
  const changed =
    parsed && parsed.ok && parsed.changes
      ? Object.keys(parsed.changes).map((k) => ATTACHMENT_LABEL[k as AttachmentSetting].toLowerCase())
      : [];
  const disabled = p.busy || p.armed || !current;
  return (
    <section className="dk-stack" aria-label="Ticket attachments" data-testid="attachments-panel">
      <h2>Ticket attachments</h2>
      <p className="dk-muted">
        What a customer may attach to a request. Until every piece below is set, attaching is refused and the customer is told which one is
        missing.
      </p>
      {!p.view ? (
        <p className="dk-muted">{p.loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : p.view.status.kind === 'failed' ? (
        <Failed name="Attachment settings" part={p.view.status} />
      ) : (
        <>
          <ul className="dk-list" data-testid="attachments-pieces">
            {status?.pieces.map((piece) => (
              <li key={piece.key} data-testid={`attachments-piece-${piece.key}`} data-set={piece.set ? 'yes' : 'no'}>
                <strong>{ATTACHMENT_PIECE_LABEL[piece.key]}</strong>: {piece.set ? 'Set' : 'Not set'}
                {!piece.set && (
                  <span className="dk-muted">
                    {' '}
                    (missing <code>{piece.key}</code>. {ATTACHMENT_PIECE_WHERE[piece.key]})
                  </span>
                )}
              </li>
            ))}
          </ul>
          <dl className="dk-kv" data-testid="attachments-current">
            {ATTACHMENT_SETTINGS.map((s) => (
              <Fragment key={s}>
                <dt>{ATTACHMENT_LABEL[s]}</dt>
                <dd data-testid={`attachments-current-${s}`}>{currentValue(status, s)}</dd>
              </Fragment>
            ))}
            <dt>Last changed</dt>
            <dd>{current?.updatedAt ? formatWhen(current.updatedAt) : 'Never'}</dd>
          </dl>
        </>
      )}

      {ATTACHMENT_SETTINGS.map((s) => (
        <div className="adm-field" key={s}>
          <label htmlFor={`sd-attachments-${s}`}>{ATTACHMENT_LABEL[s]}</label>
          {s === 'allowedTypes' ? (
            <textarea
              id={`sd-attachments-${s}`}
              className="adm-input"
              rows={4}
              value={p.form.drafts[s]}
              disabled={disabled}
              aria-describedby={`sd-attachments-${s}-hint`}
              onChange={(e) => p.onDraft(s, e.target.value)}
            />
          ) : (
            <input
              id={`sd-attachments-${s}`}
              className="adm-input"
              inputMode="numeric"
              value={p.form.drafts[s]}
              autoComplete="off"
              disabled={disabled}
              aria-describedby={`sd-attachments-${s}-hint`}
              onChange={(e) => p.onDraft(s, e.target.value)}
            />
          )}
          <small id={`sd-attachments-${s}-hint`} className="dk-muted">
            {ATTACHMENT_HINT[s]} Empty clears it.
          </small>
        </div>
      ))}
      <div className="adm-field">
        <label htmlFor="sd-attachments-reason">Reason (kept in the log)</label>
        <input
          id="sd-attachments-reason"
          className="adm-input"
          value={p.form.reason}
          maxLength={REASON_MAX}
          autoComplete="off"
          disabled={disabled}
          onChange={(e) => p.onReason(e.target.value)}
        />
      </div>
      {p.armed ? (
        <ConfirmStep
          title={`Change ${changed.join(', ') || 'these limits'}?`}
          consequence="Customers are held to it from the next attach. It is logged with your name and the reason; only a support lead can do this."
          confirmLabel="Yes, save"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(false)}
        />
      ) : (
        <div className="dk-row">
          <button type="button" className="adm-btn" data-tone="primary" disabled={!gate.ok} onClick={() => p.onArm(true)}>
            Review change
          </button>
          {!gate.ok && <span className="dk-why">{gate.why}</span>}
        </div>
      )}
      <Outcome reply={p.outcome} />
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={p.onRefresh} disabled={p.loading || p.busy}>
          {p.loading ? 'Reading…' : 'Reload limits'}
        </button>
        {p.view && <span className="dk-asof">As of {formatAsOf(p.view.asOf)}</span>}
      </div>
    </section>
  );
}

function readLimits(view: AttachmentsDeskView | null) {
  return view?.status.kind === 'ok' ? view.status.data.limits : null;
}

export function AttachmentsPanel({ initial }: { initial: AttachmentsDeskView | null }) {
  const [view, setView] = useState<AttachmentsDeskView | null>(initial);
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<AttachmentDrafts>(() => {
    const c = readLimits(initial);
    return c ? attachmentDraftsFrom(c) : emptyAttachmentDrafts;
  });
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AttachmentsReply | null>(null);
  const lock = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const next = await fetchAttachments();
    if (mine === seq.current) {
      setView(next);
      const c = readLimits(next);
      // The form follows what is stored, so after a stale answer the operator edits the newer values, not a guess.
      if (c) setDrafts(attachmentDraftsFrom(c));
      setLoading(false);
    }
  }, []);

  async function send() {
    const current = readLimits(view);
    if (lock.current || !armed || !current) return;
    const parsed = attachmentChanges(current, drafts);
    if (!parsed.ok || !parsed.changes || !attachmentGate(current, drafts, reason, false).ok) return;
    lock.current = true;
    setBusy(true);
    try {
      const reply = await postAttachments({ changes: parsed.changes, expectedRevision: current.revision, reason: reason.trim() });
      setOutcome(reply);
      setArmed(false);
      if (reply.ok) setReason('');
      // Whatever the answer, read again: after "outcome not known" the page must show what is true.
      await load();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <AttachmentsPanelView
      view={view}
      loading={loading}
      form={{ drafts, reason }}
      armed={armed}
      busy={busy}
      outcome={outcome}
      onDraft={(s, v) => setDrafts((d) => ({ ...d, [s]: v }))}
      onReason={setReason}
      onArm={(on) => {
        if (!busy) setArmed(on);
      }}
      onSend={() => void send()}
      onRefresh={() => void load()}
    />
  );
}
