'use client';

import { useEffect, useRef, useState } from 'react';
import type { SupportTicket, SupportTicketEvent } from '@intafaced/contracts';
import { fetchMacros, postMacroApply, postSupportAction, type ActionReply } from '@/lib/support/browser';
import type { SupportMacro } from '@/lib/support/types';
import {
  ESCALATION_REASONS,
  NOTE_MAX,
  REPLY_MAX,
  SUMMARY_MAX,
  allowedNextStatuses,
  escalateGate,
  replyGate,
  statusGate,
  type ActionGate,
  type EscalationReason,
  macroApplyKey,
  withSignature,
  type SupportActionRequest,
} from '@/lib/support/model';
import { ActionOutcome, ConfirmStep } from './support-action-parts';

/**
 * TICKET ACTIONS — reply, set status, escalate.
 *
 * Every control is on the page whatever the founder's permissions are. svc-support is the judge: when it answers
 * forbidden, the page says "Your console session does not have support operations permission" and nothing is
 * changed or shown as done. Each send needs a second click, and the buttons are off while a send is in progress, so a
 * double click cannot send twice. A dropped connection is "outcome not known", never "failed" or "done".
 */

export type ActionKind = 'reply' | 'status' | 'escalate';

export interface ActionForm {
  readonly replyBody: string;
  readonly statusNext: string;
  readonly statusNote: string;
  readonly escReason: EscalationReason;
  readonly escSummary: string;
  /** Article ids, separated by commas, spaces or new lines. */
  readonly escCited: string;
}

export const emptyForm = (ticket: { status: string }): ActionForm => ({
  replyBody: '',
  statusNext: allowedNextStatuses(ticket.status)[0] ?? '',
  statusNote: '',
  escReason: 'other',
  escSummary: '',
  escCited: '',
});

/** The status the select shows: the one chosen if the ticket can still go there, else the first it can go to. */
export function effectiveStatus(ticket: { status: string }, form: ActionForm): string {
  const next = allowedNextStatuses(ticket.status);
  return next.includes(form.statusNext as 'open') ? form.statusNext : (next[0] ?? '');
}

export function citedIds(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((id) => id !== ''))];
}

export function buildRequest(
  kind: ActionKind,
  ticket: { id: string; status: string },
  form: ActionForm,
  seenEventSequence: number | null = null,
): SupportActionRequest {
  const ticketId = ticket.id;
  if (kind === 'reply')
    return { action: 'reply', ticketId, body: form.replyBody.trim(), ...(seenEventSequence === null ? {} : { seenEventSequence }) };
  if (kind === 'status') {
    const note = form.statusNote.trim();
    return { action: 'status', ticketId, status: effectiveStatus(ticket, form) as 'open', ...(note ? { note } : {}) };
  }
  const cited = citedIds(form.escCited);
  return {
    action: 'escalate',
    ticketId,
    reason: form.escReason,
    summary: form.escSummary.trim(),
    ...(cited.length > 0 ? { citedArticleIds: cited } : {}),
  };
}

export interface TicketActionsViewProps {
  readonly ticket: Pick<SupportTicket, 'id' | 'status'>;
  readonly form: ActionForm;
  readonly armed: ActionKind | null;
  readonly busy: boolean;
  readonly outcome: { readonly kind: ActionKind; readonly reply: ActionReply } | null;
  readonly onField: (patch: Partial<ActionForm>) => void;
  readonly onArm: (kind: ActionKind | null) => void;
  readonly onSend: () => void;
  /**
   * The macro picker and the agent's signature. `macros` is null while unread or refused (`why` says which); `signature`
   * is undefined while unread. Absent when the page offers neither.
   */
  readonly macros?: {
    readonly list: readonly SupportMacro[] | null;
    readonly why: string | null;
    readonly signature: string | null | undefined;
    readonly onPick: (macroId: string) => void;
    readonly picking: boolean;
    readonly pickReply: ActionReply | null;
  };
  /** A reply refused as stale: what changed since it was opened (null while it is read again), and the "read" step. */
  readonly stale?: { readonly changes: readonly string[] | null; readonly onRead: () => void } | null;
}

/** The last history row of a ticket, or 0 when it has none. */
export const lastSequence = (events: readonly { sequence: number }[] | null): number =>
  events === null ? 0 : events.reduce((m, e) => Math.max(m, e.sequence), 0);

/** Someone else's history rows after the one the agent last read, in words. */
export function changesSince(events: readonly SupportTicketEvent[], seen: number, userId: string): string[] {
  const me = userId.toLowerCase();
  return events
    .filter((e) => e.sequence > seen && e.actorId.toLowerCase() !== me)
    .map((e) => `${e.kind === 'status_changed' ? `status ${e.fromStatus} → ${e.toStatus}` : e.kind}${e.note ? ` (${e.note})` : ''}`);
}

function Gated({ gate, label, onClick }: { gate: ActionGate; label: string; onClick: () => void }) {
  return (
    <div className="dk-row">
      <button type="button" className="adm-btn" data-tone="primary" disabled={!gate.ok} onClick={onClick}>
        {label}
      </button>
      {!gate.ok && <span className="dk-why">{gate.why}</span>}
    </div>
  );
}

export function TicketActionsView(p: TicketActionsViewProps) {
  const { ticket, form } = p;
  const next = allowedNextStatuses(ticket.status);
  const reply = replyGate(ticket, form.replyBody, p.busy);
  const chosen = effectiveStatus(ticket, form);
  const status = statusGate(ticket, chosen, form.statusNote, p.busy);
  const escalate = escalateGate(ticket, form.escSummary, p.busy);
  const outcome = (kind: ActionKind) => (p.outcome?.kind === kind ? p.outcome.reply : null);
  const editing = p.armed !== null;
  return (
    <section className="dk-stack" aria-label="Ticket actions" data-testid="ticket-actions">
      <h4>Reply to the customer</h4>
      {p.macros && (
        <div className="adm-field">
          <label htmlFor="sd-macro">Macro</label>
          <select
            id="sd-macro"
            value=""
            disabled={p.busy || editing || p.macros.picking || !p.macros.list}
            onChange={(e) => e.target.value !== '' && p.macros!.onPick(e.target.value)}
          >
            <option value="">{p.macros.list?.length === 0 ? 'No macros yet' : 'Choose a macro to fill the draft'}</option>
            {(p.macros.list ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.title} ({m.shortcode}){m.shared ? '' : ', yours'}
              </option>
            ))}
          </select>
          {p.macros.why && <span className="dk-why">{p.macros.why}</span>}
          <span className="dk-muted">A macro only fills the draft below. Nothing is sent until you send it.</span>
        </div>
      )}
      {p.macros?.pickReply && !p.macros.pickReply.ok && <ActionOutcome reply={p.macros.pickReply} testId="macro-outcome" />}
      <div className="adm-field">
        <label htmlFor="sd-reply">Your reply</label>
        <textarea
          id="sd-reply"
          className="adm-textarea"
          rows={4}
          maxLength={REPLY_MAX}
          value={form.replyBody}
          disabled={p.busy || editing}
          onChange={(e) => p.onField({ replyBody: e.target.value })}
        />
      </div>
      {p.macros && (
        <p className="dk-muted" data-testid="reply-signature">
          {p.macros.signature === undefined
            ? 'Reading your signature…'
            : p.macros.signature === null
              ? 'You have no signature, so the reply is sent as written. Set one under “Macros and your signature”.'
              : `Your signature closes the reply when you send it: “${p.macros.signature}”.`}
        </p>
      )}
      {p.armed === 'reply' ? (
        <ConfirmStep
          title="Send this reply?"
          consequence="The customer sees it on their request. A reply cannot be unsent."
          confirmLabel="Yes, send the reply"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(null)}
        />
      ) : (
        <Gated
          gate={editing ? { ok: false, why: 'Finish or cancel the step above first.' } : reply}
          label="Review reply"
          onClick={() => p.onArm('reply')}
        />
      )}
      {p.stale ? (
        <div className="adm-callout" role="alert" data-tone="warn" data-testid="reply-outcome">
          <strong>This request changed since you opened it</strong>
          <p>Your reply was not sent. Someone else changed the request after you read it:</p>
          {p.stale.changes === null ? (
            <p className="dk-muted">Reading what changed…</p>
          ) : (
            <ul>
              {p.stale.changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          <button type="button" className="adm-btn" onClick={p.stale.onRead} disabled={p.busy}>
            I have read the changes
          </button>
        </div>
      ) : (
        <ActionOutcome reply={outcome('reply')} testId="reply-outcome" />
      )}

      <h4>Set the status</h4>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="sd-status">New status</label>
          <select
            id="sd-status"
            className="adm-input"
            value={chosen}
            disabled={p.busy || editing || next.length === 0}
            onChange={(e) => p.onField({ statusNext: e.target.value })}
          >
            {next.length === 0 && <option value="">None: {ticket.status} is final</option>}
            {next.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="sd-status-note">
            {chosen === 'on_hold'
              ? 'Reason (required to put a request on hold, shown to the customer)'
              : 'Reason (optional, recorded in the history)'}
          </label>
          <input
            id="sd-status-note"
            className="adm-input"
            value={form.statusNote}
            maxLength={NOTE_MAX}
            autoComplete="off"
            disabled={p.busy || editing}
            onChange={(e) => p.onField({ statusNote: e.target.value })}
          />
        </div>
      </div>
      {p.armed === 'status' ? (
        <ConfirmStep
          title={`Move this ticket to ${chosen}?`}
          consequence={
            chosen === 'closed'
              ? 'Closed is final. svc-support takes no more replies, ratings or status changes on a closed ticket.'
              : 'The customer sees the new status. It is recorded in the ticket history with your name.'
          }
          confirmLabel={`Yes, set it to ${chosen}`}
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(null)}
        />
      ) : (
        <Gated
          gate={editing ? { ok: false, why: 'Finish or cancel the step above first.' } : status}
          label="Review status change"
          onClick={() => p.onArm('status')}
        />
      )}
      <ActionOutcome reply={outcome('status')} testId="status-outcome" />

      <h4>Escalate with a case file</h4>
      <p className="dk-muted">
        svc-support reads the customer’s account state and this ticket’s comments, and files them with your summary as a case file. Nothing
        here moves money: a money request is only filed, by name.
      </p>
      <div className="adm-field">
        <label htmlFor="sd-esc-reason">Why it leaves the desk</label>
        <select
          id="sd-esc-reason"
          className="adm-input"
          value={form.escReason}
          disabled={p.busy || editing}
          onChange={(e) => p.onField({ escReason: e.target.value as EscalationReason })}
        >
          {ESCALATION_REASONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div className="adm-field">
        <label htmlFor="sd-esc-summary">What you concluded (kept in the case file; no passwords or codes)</label>
        <textarea
          id="sd-esc-summary"
          className="adm-textarea"
          rows={3}
          maxLength={SUMMARY_MAX}
          value={form.escSummary}
          disabled={p.busy || editing}
          onChange={(e) => p.onField({ escSummary: e.target.value })}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="sd-esc-cited">Help articles you relied on (optional, ids separated by commas)</label>
        <input
          id="sd-esc-cited"
          className="adm-input"
          value={form.escCited}
          autoComplete="off"
          spellCheck={false}
          disabled={p.busy || editing}
          onChange={(e) => p.onField({ escCited: e.target.value })}
        />
      </div>
      {p.armed === 'escalate' ? (
        <ConfirmStep
          title="File this escalation?"
          consequence="The case file cannot be edited or withdrawn afterwards. It is recorded in the ticket history with your name."
          confirmLabel="Yes, escalate"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(null)}
        />
      ) : (
        <Gated
          gate={editing ? { ok: false, why: 'Finish or cancel the step above first.' } : escalate}
          label="Review escalation"
          onClick={() => p.onArm('escalate')}
        />
      )}
      <ActionOutcome reply={outcome('escalate')} testId="escalate-outcome" />
    </section>
  );
}

export function TicketActions({
  ticket,
  events,
  userId,
  onDone,
}: {
  ticket: SupportTicket;
  /** The history as last read, or null when it could not be read (then no reply is checked for staleness). */
  events: readonly SupportTicketEvent[] | null;
  userId: string;
  onDone: () => void;
}) {
  const [form, setForm] = useState<ActionForm>(() => emptyForm(ticket));
  // The last history row this agent has read: from when the request was opened, or "I have read the changes".
  const [seen, setSeen] = useState<number | null>(() => (events === null ? null : lastSequence(events)));
  const [stale, setStale] = useState(false);
  const [macros, setMacros] = useState<readonly SupportMacro[] | null>(null);
  const [macrosWhy, setMacrosWhy] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const [pickReply, setPickReply] = useState<ActionReply | null>(null);

  useEffect(() => {
    let live = true;
    void fetchMacros().then((m) => {
      if (!live) return;
      if (!m) return setMacrosWhy('The macros could not be read.');
      if (m.list.kind === 'ok') setMacros(m.list.data.macros);
      else setMacrosWhy(m.list.message);
      // An unread signature is not "none": the reply then goes without one and the page says so.
      setSignature(m.signature.kind === 'ok' ? m.signature.data : null);
    });
    return () => {
      live = false;
    };
  }, []);

  async function pick(macroId: string) {
    if (lock.current) return;
    lock.current = true;
    setPicking(true);
    setPickReply(null);
    try {
      const result = await postMacroApply({ ticketId: ticket.id, macroId, clientRequestId: macroApplyKey(ticket, macroId) });
      if (result.ok)
        setForm((f) => ({ ...f, replyBody: f.replyBody.trim() === '' ? result.draft : `${f.replyBody.trimEnd()}\n\n${result.draft}` }));
      else setPickReply(result);
    } finally {
      lock.current = false;
      setPicking(false);
    }
  }
  const [armed, setArmed] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TicketActionsViewProps['outcome']>(null);
  const lock = useRef(false);

  async function send() {
    if (lock.current || !armed) return;
    lock.current = true;
    setBusy(true);
    const kind = armed;
    try {
      const built = buildRequest(kind, ticket, form, seen);
      const reply = await postSupportAction(
        built.action === 'reply' ? { ...built, body: withSignature(built.body, signature ?? null) } : built,
      );
      setOutcome({ kind, reply });
      setStale(kind === 'reply' && !reply.ok && reply.refusal.code === 'support.comment_stale');
      setArmed(null);
      if (reply.ok) {
        setForm((f) =>
          kind === 'reply'
            ? { ...f, replyBody: '' }
            : kind === 'escalate'
              ? { ...f, escSummary: '', escCited: '' }
              : { ...f, statusNote: '' },
        );
      }
      // Whatever the answer, read the ticket again: after "outcome not known" the page must show what is true.
      onDone();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <TicketActionsView
      ticket={ticket}
      form={form}
      armed={armed}
      busy={busy}
      outcome={outcome}
      onField={(patch) => setForm((f) => ({ ...f, ...patch }))}
      onArm={(kind) => {
        if (!busy) setArmed(kind);
      }}
      onSend={() => void send()}
      macros={{ list: macros, why: macrosWhy, signature, onPick: (id) => void pick(id), picking, pickReply }}
      stale={
        stale
          ? {
              changes: events === null || seen === null ? null : changesSince(events, seen, userId),
              onRead: () => {
                setSeen(lastSequence(events));
                setStale(false);
                setOutcome(null);
              },
            }
          : null
      }
    />
  );
}
