'use client';

import { Fragment, useCallback, useRef, useState } from 'react';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import {
  CONTACT_HINT,
  CONTACT_LABEL,
  CONTACT_SETTINGS,
  REASON_MAX,
  contactChanges,
  contactGate,
  draftsFrom,
  type ContactChannels,
  type ContactDrafts,
  type ContactSetting,
} from '@/lib/support/contact';
import { fetchContact, postContact, type ContactDeskView, type ContactReply } from '@/lib/support/contact-browser';
import { ConfirmStep, Failed } from './support-action-parts';

/**
 * SUPPORT CONTACT — the owner-set email, phone and chat hours the help centre shows.
 *
 * Nothing is built in: a channel that is not set reads "Not set" here and on the help centre, which then shows no link for
 * it. Saving names the revision this page read, so a change by someone else is refused instead of overwritten, and the page
 * reads again after every answer so what it shows is what is stored. Only a staff lead can save; others read.
 */

export interface ContactForm {
  readonly drafts: ContactDrafts;
  readonly reason: string;
}

export const emptyContactDrafts: ContactDrafts = { email: '', phone: '', chatHours: '' };

export interface ContactPanelViewProps {
  readonly view: ContactDeskView | null;
  readonly loading: boolean;
  readonly form: ContactForm;
  readonly armed: boolean;
  readonly busy: boolean;
  readonly outcome: ContactReply | null;
  readonly onDraft: (setting: ContactSetting, value: string) => void;
  readonly onReason: (value: string) => void;
  readonly onArm: (on: boolean) => void;
  readonly onSend: () => void;
  readonly onRefresh: () => void;
}

function Outcome({ reply }: { reply: ContactReply | null }) {
  if (!reply) return null;
  if (reply.ok) {
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="contact-outcome">
        <strong>Saved</strong>
        <p>The help centre now reads revision {reply.contact.revision}.</p>
      </div>
    );
  }
  const r = reply.refusal;
  return (
    <div className="adm-callout" role="alert" data-tone={r.changed === 'unknown' ? 'warn' : 'danger'} data-testid="contact-outcome">
      <strong>{r.title}</strong>
      <p>{r.body}</p>
      <p>{r.next}</p>
    </div>
  );
}

export function ContactPanelView(p: ContactPanelViewProps) {
  const current = p.view?.contact.kind === 'ok' ? p.view.contact.data : null;
  const gate = current
    ? contactGate(current, p.form.drafts, p.form.reason, p.busy)
    : ({ ok: false, why: 'The current details could not be read.' } as const);
  const changes = current ? contactChanges(current, p.form.drafts) : null;
  const changed = changes ? Object.keys(changes).map((k) => CONTACT_LABEL[k as ContactSetting].toLowerCase()) : [];
  const disabled = p.busy || p.armed || !current;
  return (
    <section className="dk-stack" aria-label="Support contact details" data-testid="contact-panel">
      <h2>Contact details</h2>
      <p className="dk-muted">
        What the help centre and contact page show a visitor. A detail left empty is shown as not set, with no link.
      </p>
      {!p.view ? (
        <p className="dk-muted">{p.loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : p.view.contact.kind === 'failed' ? (
        <Failed name="Contact details" part={p.view.contact} />
      ) : (
        <dl className="dk-kv" data-testid="contact-current">
          {CONTACT_SETTINGS.map((s) => (
            <Fragment key={s}>
              <dt>{CONTACT_LABEL[s]}</dt>
              <dd data-testid={`contact-current-${s}`}>{current?.[s] ?? 'Not set'}</dd>
            </Fragment>
          ))}
          <dt>Last changed</dt>
          <dd>{current?.updatedAt ? formatWhen(current.updatedAt) : 'Never'}</dd>
        </dl>
      )}

      {CONTACT_SETTINGS.map((s) => (
        <div className="adm-field" key={s}>
          <label htmlFor={`sd-contact-${s}`}>{CONTACT_LABEL[s]}</label>
          <input
            id={`sd-contact-${s}`}
            className="adm-input"
            value={p.form.drafts[s]}
            autoComplete="off"
            disabled={disabled}
            aria-describedby={`sd-contact-${s}-hint`}
            onChange={(e) => p.onDraft(s, e.target.value)}
          />
          <small id={`sd-contact-${s}-hint`} className="dk-muted">
            {CONTACT_HINT[s]} Empty clears it.
          </small>
        </div>
      ))}
      <div className="adm-field">
        <label htmlFor="sd-contact-reason">Reason (kept in the log)</label>
        <input
          id="sd-contact-reason"
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
          title={`Change ${changed.join(', ') || 'these details'}?`}
          consequence="Visitors see it straight away. It is logged with your name and the reason; only a support lead can do this."
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
          {p.loading ? 'Reading…' : 'Reload details'}
        </button>
        {p.view && <span className="dk-asof">As of {formatAsOf(p.view.asOf)}</span>}
      </div>
    </section>
  );
}

function readCurrent(view: ContactDeskView | null): ContactChannels | null {
  return view?.contact.kind === 'ok' ? view.contact.data : null;
}

export function ContactPanel({ initial }: { initial: ContactDeskView | null }) {
  const [view, setView] = useState<ContactDeskView | null>(initial);
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<ContactDrafts>(() => {
    const c = readCurrent(initial);
    return c ? draftsFrom(c) : emptyContactDrafts;
  });
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ContactReply | null>(null);
  const lock = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const next = await fetchContact();
    if (mine === seq.current) {
      setView(next);
      const c = readCurrent(next);
      // The form follows what is stored, so after a stale answer the operator edits the newer values, not a guess.
      if (c) setDrafts(draftsFrom(c));
      setLoading(false);
    }
  }, []);

  async function send() {
    const current = readCurrent(view);
    if (lock.current || !armed || !current) return;
    const changes = contactChanges(current, drafts);
    if (!changes || !contactGate(current, drafts, reason, false).ok) return;
    lock.current = true;
    setBusy(true);
    try {
      const reply = await postContact({ changes, expectedRevision: current.revision, reason: reason.trim() });
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
    <ContactPanelView
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
