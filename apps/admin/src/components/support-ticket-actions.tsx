'use client';

import { useRef, useState } from 'react';
import type { SupportTicket, SupportTicketEvent } from '@intafaced/contracts';
import type { Part } from '@/lib/desk/part';
import { postSupportAction, type ActionReply } from '@/lib/support/browser';
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
  type SupportActionRequest,
} from '@/lib/support/model';
import { lastSequence, newerByOthers, trailWords } from '@/lib/support/trail';
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
  expectedSequence?: number,
): SupportActionRequest {
  const ticketId = ticket.id;
  if (kind === 'reply')
    return { action: 'reply', ticketId, body: form.replyBody.trim(), ...(expectedSequence === undefined ? {} : { expectedSequence }) };
  if (kind === 'status') {
    const note = form.statusNote.trim();
    return {
      action: 'status',
      ticketId,
      status: effectiveStatus(ticket, form) as 'open',
      ...(note ? { note } : {}),
      ...(expectedSequence === undefined ? {} : { expectedSequence }),
    };
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
  /** Rows someone else wrote since the agent last read the trail, shown when a reply is refused as stale. */
  readonly stale?: readonly SupportTicketEvent[];
  /** Why the reply cannot be checked for changes (the trail could not be read); null when it can. */
  readonly trailUnread?: string | null;
  /** The agent has read the changes: the next reply is checked from the latest row. */
  readonly onReadChanges?: () => void;
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
  const gate = replyGate(ticket, form.replyBody, p.busy);
  const reply: ActionGate = gate.ok && p.trailUnread ? { ok: false, why: p.trailUnread } : gate;
  const chosen = effectiveStatus(ticket, form);
  const status = statusGate(ticket, chosen, form.statusNote, p.busy);
  const escalate = escalateGate(ticket, form.escSummary, p.busy);
  const outcome = (kind: ActionKind) => (p.outcome?.kind === kind ? p.outcome.reply : null);
  const editing = p.armed !== null;
  return (
    <section className="dk-stack" aria-label="Ticket actions" data-testid="ticket-actions">
      <h4>Reply to the customer</h4>
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
      <ActionOutcome reply={outcome('reply')} testId="reply-outcome">
        <StaleChanges p={p} kind="reply" />
      </ActionOutcome>

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
      <ActionOutcome reply={outcome('status')} testId="status-outcome">
        <StaleChanges p={p} kind="status" />
      </ActionOutcome>

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

/** Under a stale refusal: what someone else changed since the agent read the request, and the way to send again. */
function StaleChanges({ p, kind }: { p: TicketActionsViewProps; kind: ActionKind }) {
  if (p.outcome?.kind !== kind || p.outcome.reply.ok || p.outcome.reply.refusal.code !== 'support.stale_ticket') return null;
  return (
    <>
      <ol aria-label="Changes since you opened it" data-testid={`${kind}-stale-rows`}>
        {(p.stale ?? []).map((e) => (
          <li key={e.id}>{trailWords(e)}</li>
        ))}
      </ol>
      <button type="button" className="adm-btn" onClick={p.onReadChanges} disabled={p.busy}>
        I have read the changes
      </button>
    </>
  );
}

export function TicketActions({
  ticket,
  events,
  userId,
  onDone,
}: {
  ticket: SupportTicket;
  /** The trail as last read: a reply quotes the last row the agent has read, and svc-support refuses it if someone moved on since. */
  events: Part<readonly SupportTicketEvent[]>;
  userId: string;
  onDone: () => void;
}) {
  const [form, setForm] = useState<ActionForm>(() => emptyForm(ticket));
  const rows = events.kind === 'ok' ? events.data : [];
  // What the agent has read: the trail when the request was opened, moved on only by "I have read the changes".
  const [seen, setSeen] = useState<number | null>(() => (events.kind === 'ok' ? lastSequence(events.data) : null));
  const seenNow = seen ?? (events.kind === 'ok' ? lastSequence(rows) : null);
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
      if (seen === null && seenNow !== null) setSeen(seenNow);
      const reply = await postSupportAction(buildRequest(kind, ticket, form, kind === 'escalate' ? undefined : (seenNow ?? undefined)));
      setOutcome({ kind, reply });
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
      stale={seenNow === null ? [] : newerByOthers(rows, seenNow, userId)}
      trailUnread={
        seenNow === null
          ? 'The ticket history could not be read, so a change by someone else cannot be checked. Read the ticket again first.'
          : null
      }
      onReadChanges={() => {
        if (events.kind !== 'ok') return;
        setSeen(lastSequence(rows));
        setOutcome(null);
      }}
    />
  );
}
