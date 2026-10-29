'use client';

import { useEffect, useRef, useState } from 'react';
import type { SupportTicket, SupportTicketEvent } from '@intafaced/contracts';
import { SUPPORT_SIGNATURE_MAX, supportMacroUnfilled, type SupportMacro } from '@intafaced/contracts/support-macros';
import type { Part } from '@/lib/desk/part';
import { fetchMacroApply, fetchMacros, postSupportAction, type ActionReply, type MacroApplyReply } from '@/lib/support/browser';
import type { SupportMacrosView } from '@/lib/support/types';
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
import { ActionOutcome, ConfirmStep, Failed } from './support-action-parts';

/**
 * TICKET ACTIONS — reply, set status, escalate.
 *
 * A macro (SP-desk-02) is filled from this request by svc-support and only goes into the reply draft: nothing is sent
 * until the agent sends. A placeholder svc-support could not fill stays in the draft as written, and svc-support refuses
 * to send a reply still holding one. The agent's own signature is put into the public reply's draft when it is composed,
 * so the agent sees exactly what the customer gets; nothing is added on send, and a status reason or an escalation's
 * summary never carries it.
 *
 * Every control is on the page whatever the founder's permissions are. svc-support is the judge: when it answers
 * forbidden, the page says "Your console session does not have support operations permission" and nothing is
 * changed or shown as done. Each send needs a second click, and the buttons are off while a send is in progress, so a
 * double click cannot send twice. A dropped connection is "outcome not known", never "failed" or "done".
 */

export type ActionKind = 'reply' | 'status' | 'escalate' | 'signature';

export interface ActionForm {
  readonly replyBody: string;
  readonly statusNext: string;
  readonly statusNote: string;
  readonly escReason: EscalationReason;
  readonly escSummary: string;
  /** Article ids, separated by commas, spaces or new lines. */
  readonly escCited: string;
  /** The agent's own signature as they are editing it; null until they start. */
  readonly signatureDraft: string | null;
}

export const emptyForm = (ticket: { status: string }): ActionForm => ({
  replyBody: '',
  statusNext: allowedNextStatuses(ticket.status)[0] ?? '',
  statusNote: '',
  escReason: 'other',
  escSummary: '',
  escCited: '',
  signatureDraft: null,
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
  sent?: number,
  signature: { readonly signature: string | null; readonly revision: number } = { signature: null, revision: 0 },
): SupportActionRequest {
  const ticketId = ticket.id;
  if (kind === 'signature')
    return { action: 'signature_set', signature: (form.signatureDraft ?? '').trim(), expectedRevision: signature.revision };
  if (kind === 'reply')
    return {
      action: 'reply',
      ticketId,
      // Exactly the draft the agent saw, signature included: nothing is added on send.
      body: form.replyBody.trim(),
      ...(expectedSequence === undefined ? {} : { expectedSequence }),
      ...(sent === undefined ? {} : { sent }),
    };
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
  /** The desk's macros and the agent's signature; null while they are read. */
  readonly macros?: SupportMacrosView | null;
  /** svc-support's answer to the last macro applied, shown when it refused. */
  readonly macroReply?: MacroApplyReply | null;
  readonly onMacro?: (macroId: string) => void;
  /** Reads the macros and the signature again after a failed read. */
  readonly onMacrosRead?: () => void;
}

const macroLabel = (m: SupportMacro) => `${m.folder === null ? m.title : `${m.folder} / ${m.title}`} (${m.shortcode})`;

/** What a fresh public reply's draft holds: the agent's signature under room to write, or nothing without one. */
export function signatureBlock(signature: string | null): string {
  return signature === null ? '' : `\n\n${signature}`;
}

/** The agent's own words in a draft: the draft less the signature block at its end, if it is still there. */
export function draftWords(body: string, signature: string | null): string {
  const block = signatureBlock(signature);
  return block !== '' && body.endsWith(block) ? body.slice(0, body.length - block.length) : body;
}

/** A macro's text put into a draft: under what the agent already wrote, above their signature. */
export function withMacro(body: string, text: string, signature: string | null): string {
  const words = draftWords(body, signature).trimEnd();
  const filled = words.trim() === '' ? text : `${words}\n\n${text}`;
  const block = signatureBlock(signature);
  return block !== '' && body.endsWith(block) ? `${filled}${block}` : filled;
}

/** The signature that goes into a reply's draft, or why it is not known yet. A reply waits until it is known. */
function signatureOf(
  macros: SupportMacrosView | null | undefined,
): { ok: true; signature: string | null; revision: number } | { ok: false; why: string } {
  if (!macros) return { ok: false, why: 'Reading your signature first.' };
  if (macros.signature.kind !== 'ok')
    return { ok: false, why: 'Your signature could not be read, so the reply cannot be signed. Read it again first.' };
  return { ok: true, signature: macros.signature.data.signature, revision: macros.signature.data.revision };
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
  const signed = signatureOf(p.macros);
  // A draft holding only the signature is refused as blank: the signature alone is never a reply.
  const words = draftWords(form.replyBody, signed.ok ? signed.signature : null);
  const gate = replyGate(ticket, words.trim() === '' ? '' : form.replyBody, p.busy);
  const unfilled = supportMacroUnfilled(form.replyBody);
  const reply: ActionGate =
    gate.ok && p.trailUnread ? { ok: false, why: p.trailUnread } : gate.ok && !signed.ok ? { ok: false, why: signed.why } : gate;
  const signatureText = (form.signatureDraft ?? (signed.ok ? (signed.signature ?? '') : '')).trim();
  const signatureGate: ActionGate = p.busy
    ? { ok: false, why: 'A step is already in progress.' }
    : !signed.ok
      ? { ok: false, why: signed.why }
      : signatureText === ''
        ? { ok: false, why: 'Write your signature first.' }
        : signatureText === signed.signature
          ? { ok: false, why: 'This is already your signature.' }
          : { ok: true };
  const chosen = effectiveStatus(ticket, form);
  const status = statusGate(ticket, chosen, form.statusNote, p.busy);
  const escalate = escalateGate(ticket, form.escSummary, p.busy);
  const outcome = (kind: ActionKind) => (p.outcome?.kind === kind ? p.outcome.reply : null);
  const editing = p.armed !== null;
  return (
    <section className="dk-stack" aria-label="Ticket actions" data-testid="ticket-actions">
      <h4>Reply to the customer</h4>
      <MacroPicker p={p} disabled={p.busy || editing} />
      {p.macros && (p.macros.macros.kind !== 'ok' || p.macros.signature.kind !== 'ok') && (
        <button type="button" className="adm-btn" disabled={p.busy} onClick={() => p.onMacrosRead?.()}>
          Read the macros and your signature again
        </button>
      )}
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
      {unfilled.length > 0 && (
        <p className="dk-why" data-testid="reply-unfilled">
          {`Fill in or remove ${unfilled.map((name) => `{{${name}}}`).join(', ')}: the desk holds no value for it on this request, and svc-support sends no reply that still holds one.`}
        </p>
      )}
      {p.armed === 'reply' ? (
        <ConfirmStep
          title="Send this reply?"
          consequence="The customer sees it on their request exactly as written above. A reply cannot be unsent."
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

      <div className="adm-field">
        <label htmlFor="sd-signature">Your signature (put into your public reply drafts only)</label>
        <textarea
          id="sd-signature"
          className="adm-textarea"
          rows={2}
          maxLength={SUPPORT_SIGNATURE_MAX}
          value={form.signatureDraft ?? (signed.ok ? (signed.signature ?? '') : '')}
          disabled={p.busy || editing || !signed.ok}
          onChange={(e) => p.onField({ signatureDraft: e.target.value })}
        />
      </div>
      {p.armed === 'signature' ? (
        <ConfirmStep
          title="Save this signature?"
          consequence="It goes into each new public reply draft from now on, where you can still change it. A draft you have already started and replies already sent keep the text they have."
          confirmLabel="Yes, save my signature"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(null)}
        />
      ) : (
        <Gated
          gate={editing ? { ok: false, why: 'Finish or cancel the step above first.' } : signatureGate}
          label="Review signature"
          onClick={() => p.onArm('signature')}
        />
      )}
      <ActionOutcome reply={outcome('signature')} testId="signature-outcome" />

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

/** The desk's macros. Choosing one fills the draft from this request; nothing is sent until the agent sends. */
function MacroPicker({ p, disabled }: { p: TicketActionsViewProps; disabled: boolean }) {
  if (!p.macros) return <p className="dk-muted">Reading the desk's macros.</p>;
  if (p.macros.macros.kind !== 'ok') return <Failed name="Macros" part={p.macros.macros} />;
  const list = p.macros.macros.data;
  const refused = p.macroReply && !p.macroReply.ok ? p.macroReply.refusal : null;
  return (
    <>
      <div className="adm-field">
        <label htmlFor="sd-macro">Macro</label>
        <select
          id="sd-macro"
          className="adm-input"
          value=""
          disabled={disabled || list.length === 0}
          onChange={(e) => {
            if (e.target.value !== '') p.onMacro?.(e.target.value);
          }}
        >
          <option value="">{list.length === 0 ? 'None: no macro has been written yet' : 'Fill the reply from a macro'}</option>
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {macroLabel(m)}
            </option>
          ))}
        </select>
      </div>
      {p.macroReply && !p.macroReply.ok && (
        <div className="adm-callout" role="alert" data-tone="danger" data-testid="macro-outcome" data-code={refused?.code ?? undefined}>
          <strong>{refused?.title ?? 'The macro could not be read'}</strong>
          <p>{refused?.body ?? 'The draft was not changed. Choose the macro again.'}</p>
        </div>
      )}
    </>
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
  // Replies sent from this view: moves only on a recorded reply, so a retry after "outcome not known" keeps its key.
  const [sent, setSent] = useState(0);
  const [macros, setMacros] = useState<SupportMacrosView | null>(null);
  const [macroReply, setMacroReply] = useState<MacroApplyReply | null>(null);
  const [macrosRead, setMacrosRead] = useState(0);
  const lock = useRef(false);
  const signature = macros?.signature.kind === 'ok' ? macros.signature.data.signature : null;
  // The signature goes into the draft when the reply is composed: an untouched draft follows the signature as read.
  const drafted = useRef('');
  useEffect(() => {
    if (macros?.signature.kind !== 'ok') return;
    const block = signatureBlock(signature);
    const before = drafted.current;
    drafted.current = block;
    setForm((f) => (f.replyBody === '' || f.replyBody === before ? { ...f, replyBody: block } : f));
  }, [macros, signature]);

  useEffect(() => {
    const abort = new AbortController();
    void fetchMacros(abort.signal).then((view) => {
      if (abort.signal.aborted) return;
      setMacros(
        view ?? {
          asOf: new Date().toISOString(),
          macros: { kind: 'failed', message: 'The macros could not be read.', code: null, notBuilt: false, forbidden: false },
          signature: { kind: 'failed', message: 'Your signature could not be read.', code: null, notBuilt: false, forbidden: false },
        },
      );
    });
    return () => abort.abort();
  }, [macrosRead]);

  async function applyMacro(macroId: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const reply = await fetchMacroApply(ticket.id, macroId);
      setMacroReply(reply);
      // The macro goes under what the agent already wrote and above their signature; it never discards their draft.
      if (reply.ok) setForm((f) => ({ ...f, replyBody: withMacro(f.replyBody, reply.applied.text, signature) }));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function send() {
    if (lock.current || !armed) return;
    lock.current = true;
    setBusy(true);
    const kind = armed;
    try {
      if (seen === null && seenNow !== null) setSeen(seenNow);
      const read = macros?.signature.kind === 'ok' ? macros.signature.data : undefined;
      const reply = await postSupportAction(
        buildRequest(
          kind,
          ticket,
          form,
          kind === 'escalate' || kind === 'signature' ? undefined : (seenNow ?? undefined),
          kind === 'reply' ? sent : undefined,
          read,
        ),
      );
      setOutcome({ kind, reply });
      setArmed(null);
      if (reply.ok && kind === 'reply') setSent((n) => n + 1);
      if (reply.ok) {
        setForm((f) =>
          kind === 'reply'
            ? { ...f, replyBody: signatureBlock(signature) }
            : kind === 'escalate'
              ? { ...f, escSummary: '', escCited: '' }
              : kind === 'signature'
                ? { ...f, signatureDraft: null }
                : { ...f, statusNote: '' },
        );
      }
      // A signature write (done or not) is read back from svc-support before it goes into the next draft.
      if (kind === 'signature') {
        setMacros(null);
        setMacrosRead((n) => n + 1);
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
      macros={macros}
      macroReply={macroReply}
      onMacro={(id) => void applyMacro(id)}
      onMacrosRead={() => setMacrosRead((n) => n + 1)}
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
