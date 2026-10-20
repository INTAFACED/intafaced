'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupportTicket, SupportTicketProperties } from '@intafaced/contracts';
import { fetchTicketProperties, postSupportAction, type ActionReply } from '@/lib/support/browser';
import {
  PRIORITIES,
  REASON_MAX,
  TICKET_TYPES,
  parseLabels,
  propertiesGate,
  type Priority,
  type PropertiesChange,
  type TicketType,
} from '@/lib/support/model';
import type { SupportPropertiesView } from '@/lib/support/types';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { ActionOutcome, ConfirmStep, Failed } from './support-action-parts';

/**
 * PRIORITY, TYPE AND LABELS — set by an agent, never shown to the customer.
 *
 * svc-support keeps these beside the ticket, not on it, so the customer's own read of their request never carries them.
 * A priority or type nobody set reads "Not set", never a guessed value. Changing them needs a second click, and the
 * request id is made once when the change is armed, so a retry of the same step cannot record it twice.
 */

const KEEP = 'keep';
const CLEAR = 'clear';

export interface PropertiesForm {
  /** `keep` leaves it as it is, `clear` removes it, otherwise the value. */
  readonly priority: string;
  readonly ticketType: string;
  /** Labels typed as text; `null` until the person edits them, which leaves the labels as they are. */
  readonly labels: string | null;
  readonly reason: string;
}

export const emptyPropertiesForm: PropertiesForm = { priority: KEEP, ticketType: KEEP, labels: null, reason: '' };

/** What the form asks for, against what svc-support holds now. A field left alone, or typed back to what it was, is not sent. */
export function changeFrom(current: SupportTicketProperties | null, form: PropertiesForm): PropertiesChange {
  const out: { priority?: Priority | null; ticketType?: TicketType | null; labels?: readonly string[] } = {};
  if (form.priority === CLEAR) out.priority = null;
  else if (form.priority !== KEEP && form.priority !== current?.priority) out.priority = form.priority as Priority;
  if (form.ticketType === CLEAR) out.ticketType = null;
  else if (form.ticketType !== KEEP && form.ticketType !== current?.ticketType) out.ticketType = form.ticketType as TicketType;
  if (form.labels !== null) {
    const next = parseLabels(form.labels);
    const now = current?.labels ?? [];
    if (next.length !== now.length || next.some((l, i) => l !== now[i])) out.labels = next;
  }
  // Clearing something that is not set is no change.
  if (out.priority === null && current?.priority === null) delete out.priority;
  if (out.ticketType === null && current?.ticketType === null) delete out.ticketType;
  return out;
}

export interface TicketPropertiesViewProps {
  readonly ticket: Pick<SupportTicket, 'id' | 'status'>;
  readonly view: SupportPropertiesView | null;
  readonly loading: boolean;
  readonly form: PropertiesForm;
  readonly armed: boolean;
  readonly busy: boolean;
  readonly outcome: ActionReply | null;
  readonly onField: (patch: Partial<PropertiesForm>) => void;
  readonly onArm: (on: boolean) => void;
  readonly onSend: () => void;
}

const label = (value: string | null) => (value === null ? 'Not set' : value);

export function TicketPropertiesView(p: TicketPropertiesViewProps) {
  const part = p.view?.properties;
  const current = part?.kind === 'ok' ? part.data : null;
  const change = changeFrom(current, p.form);
  const gate = propertiesGate(p.ticket, change, p.form.reason, p.busy);
  const disabled = p.busy || p.armed;
  return (
    <section className="dk-stack" aria-label="Priority, type and labels" data-testid="ticket-properties">
      <h4>Priority, type and labels</h4>
      <p className="dk-muted">Only support staff see these. The customer’s own view of the request does not carry them.</p>
      {!p.view ? (
        <p className="dk-muted">{p.loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : part?.kind === 'failed' ? (
        <Failed name="Properties" part={part} />
      ) : current ? (
        <dl className="dk-kv">
          <dt>Priority</dt>
          <dd data-testid="prop-priority">{label(current.priority)}</dd>
          <dt>Type</dt>
          <dd data-testid="prop-type">{label(current.ticketType)}</dd>
          <dt>Labels</dt>
          <dd data-testid="prop-labels">{current.labels.length === 0 ? 'None' : current.labels.join(', ')}</dd>
          <dt>Last changed</dt>
          <dd>{current.updatedAt ? formatWhen(current.updatedAt) : 'Never'}</dd>
        </dl>
      ) : null}

      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="sd-prop-priority">Priority</label>
          <select
            id="sd-prop-priority"
            className="adm-input"
            value={p.form.priority}
            disabled={disabled}
            onChange={(e) => p.onField({ priority: e.target.value })}
          >
            <option value={KEEP}>Leave as it is</option>
            {PRIORITIES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
            <option value={CLEAR}>Clear it</option>
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="sd-prop-type">Type</label>
          <select
            id="sd-prop-type"
            className="adm-input"
            value={p.form.ticketType}
            disabled={disabled}
            onChange={(e) => p.onField({ ticketType: e.target.value })}
          >
            <option value={KEEP}>Leave as it is</option>
            {TICKET_TYPES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
            <option value={CLEAR}>Clear it</option>
          </select>
        </div>
      </div>
      <div className="adm-field">
        <label htmlFor="sd-prop-labels">
          Labels (replaces the whole set; letters, digits, hyphen and underscore, separated by spaces or commas)
        </label>
        <input
          id="sd-prop-labels"
          className="adm-input"
          value={p.form.labels ?? (current?.labels ?? []).join(' ')}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => p.onField({ labels: e.target.value })}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="sd-prop-reason">Reason (optional, kept in the log)</label>
        <input
          id="sd-prop-reason"
          className="adm-input"
          value={p.form.reason}
          maxLength={REASON_MAX}
          autoComplete="off"
          disabled={disabled}
          onChange={(e) => p.onField({ reason: e.target.value })}
        />
      </div>
      {p.armed ? (
        <ConfirmStep
          title="Save these changes?"
          consequence="Only the fields you changed are sent. The change is logged with your name. Customers do not see it."
          confirmLabel="Yes, save"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(false)}
        />
      ) : (
        <div className="dk-row">
          <button type="button" className="adm-btn" data-tone="primary" disabled={!gate.ok} onClick={() => p.onArm(true)}>
            Review changes
          </button>
          {!gate.ok && <span className="dk-why">{gate.why}</span>}
        </div>
      )}
      <ActionOutcome reply={p.outcome} testId="properties-outcome" />
      {p.view && <span className="dk-asof">As of {formatAsOf(p.view.asOf)}</span>}
    </section>
  );
}

export function TicketProperties({ ticket, onDone }: { ticket: SupportTicket; onDone?: () => void }) {
  const [view, setView] = useState<SupportPropertiesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<PropertiesForm>(emptyPropertiesForm);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionReply | null>(null);
  const lock = useRef(false);
  const requestId = useRef('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const next = await fetchTicketProperties(ticket.id);
    if (mine === seq.current) {
      setView(next);
      setLoading(false);
    }
  }, [ticket.id]);

  useEffect(() => {
    setForm(emptyPropertiesForm);
    setArmed(false);
    setOutcome(null);
    void load();
  }, [load]);

  const current = view?.properties.kind === 'ok' ? view.properties.data : null;

  async function send() {
    if (lock.current || !armed) return;
    const change = changeFrom(current, form);
    if (!propertiesGate(ticket, change, form.reason, false).ok) return;
    lock.current = true;
    setBusy(true);
    try {
      const reason = form.reason.trim();
      const reply = await postSupportAction({
        action: 'properties',
        ticketId: ticket.id,
        clientRequestId: requestId.current,
        ...(reason ? { reason } : {}),
        ...change,
      });
      setOutcome(reply);
      setArmed(false);
      if (reply.ok) setForm(emptyPropertiesForm);
      // Whatever the answer, read again: after "outcome not known" the page must show what is true.
      await load();
      onDone?.();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <TicketPropertiesView
      ticket={ticket}
      view={view}
      loading={loading}
      form={form}
      armed={armed}
      busy={busy}
      outcome={outcome}
      onField={(patch) => setForm((f) => ({ ...f, ...patch }))}
      onArm={(on) => {
        if (busy) return;
        // One request id per armed decision: a retry of the same confirm reuses it, a new decision gets a new one.
        if (on) requestId.current = `props:${crypto.randomUUID()}`;
        setArmed(on);
      }}
      onSend={() => void send()}
    />
  );
}
