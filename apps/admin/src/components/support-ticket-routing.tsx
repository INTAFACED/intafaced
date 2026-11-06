'use client';

import { useEffect, useRef, useState } from 'react';
import type { SupportTicket } from '@intafaced/contracts';
import { formatWhen } from '@/lib/as-of';
import { fetchTicketRouting, postSupportAction, type ActionReply } from '@/lib/support/browser';
import { ROUTING_LEAD_ONLY, SKILL_PATTERN, skillGate, ticketStateWords } from '@/lib/support/routing';
import type { SupportTicketRoutingView } from '@/lib/support/types';
import { ActionOutcome, ConfirmStep, Failed } from './support-action-parts';

/**
 * ROUTING — the skill a request needs, and whether svc-support gave it to someone automatically.
 *
 * "No agent available" carries svc-support's own code, `support.no_agent_available`. A lead sets or clears the required
 * skill; svc-support then routes the request again and says what happened. Nothing is guessed: a failed read is shown as
 * that part's refusal.
 */

export interface TicketRoutingViewProps {
  readonly view: SupportTicketRoutingView | null;
  readonly loading: boolean;
  readonly skill: string;
  readonly armed: boolean;
  readonly busy: boolean;
  readonly outcome: ActionReply | null;
  readonly onSkill: (skill: string) => void;
  readonly onArm: (on: boolean) => void;
  readonly onSend: () => void;
}

export function TicketRoutingView(p: TicketRoutingViewProps) {
  const routing = p.view?.routing.kind === 'ok' ? p.view.routing.data : null;
  const roster = p.view?.roster.kind === 'ok' ? p.view.roster.data : null;
  const me = roster?.find((m) => m.userId === p.view?.meId) ?? null;
  const gate = !roster ? ({ ok: false, why: 'The staff list could not be read.' } as const) : skillGate(me, p.skill, routing, p.busy);
  const next = p.skill.trim().toLowerCase();
  const disabled = p.busy || p.armed;
  return (
    <section className="dk-stack" aria-label="Routing" data-testid="ticket-routing">
      <h4>Routing</h4>
      {!p.view ? (
        <p className="dk-muted">{p.loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : p.view.routing.kind === 'failed' ? (
        <Failed name="Routing" part={p.view.routing} />
      ) : (
        routing && (
          <dl className="dk-kv">
            <dt>Required skill</dt>
            <dd data-testid="routing-skill">{routing.requiredSkill ?? 'No skill needed'}</dd>
            <dt>State</dt>
            <dd data-testid="routing-state">
              {ticketStateWords(routing)}
              {routing.code && (
                <>
                  {' '}
                  <code className="dk-packet">{routing.code}</code>
                </>
              )}
            </dd>
            <dt>Since</dt>
            <dd data-testid="routing-since">{routing.stateAt ? formatWhen(routing.stateAt) : '—'}</dd>
          </dl>
        )
      )}
      {p.view?.roster.kind === 'failed' && <Failed name="Staff list" part={p.view.roster} />}
      {me && me.role !== 'lead' && (
        <p className="dk-muted" data-testid="routing-not-lead">
          {ROUTING_LEAD_ONLY}
        </p>
      )}
      <div className="adm-field">
        <label htmlFor="sd-ticket-skill">Required skill (blank for none)</label>
        <input
          id="sd-ticket-skill"
          className="adm-input"
          value={p.skill}
          maxLength={40}
          autoComplete="off"
          disabled={disabled || !routing}
          onChange={(e) => p.onSkill(e.target.value)}
        />
      </div>
      {p.armed ? (
        <ConfirmStep
          title={next === '' ? 'Clear the required skill?' : `Make this request need ${next}?`}
          consequence="svc-support routes the request again straight away and logs the change with your name."
          confirmLabel="Yes, set skill"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(false)}
        />
      ) : (
        <div className="dk-row">
          <button type="button" className="adm-btn" data-tone="primary" disabled={!gate.ok || disabled} onClick={() => p.onArm(true)}>
            Review skill
          </button>
          {!gate.ok && <span className="dk-why">{gate.why}</span>}
        </div>
      )}
      <ActionOutcome reply={p.outcome} testId="routing-outcome" />
    </section>
  );
}

/** Reads again when the ticket changes, and after every skill change. */
export function TicketRouting({ ticket, onDone }: { ticket: Pick<SupportTicket, 'id' | 'status' | 'updatedAt'>; onDone?: () => void }) {
  const [view, setView] = useState<SupportTicketRoutingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [skill, setSkill] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionReply | null>(null);
  const [tick, setTick] = useState(0);
  const lock = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetchTicketRouting(ticket.id, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setView(next);
      setLoading(false);
      if (next?.routing.kind === 'ok') setSkill(next.routing.data.requiredSkill ?? '');
    });
    return () => controller.abort();
  }, [ticket.id, ticket.status, ticket.updatedAt, tick]);

  async function send() {
    if (lock.current || !armed || !view || view.roster.kind !== 'ok' || view.routing.kind !== 'ok') return;
    const me = view.roster.data.find((m) => m.userId === view.meId) ?? null;
    if (!skillGate(me, skill, view.routing.data, false).ok) return;
    const next = skill.trim().toLowerCase();
    if (next !== '' && !SKILL_PATTERN.test(next)) return;
    lock.current = true;
    setBusy(true);
    try {
      const reply = await postSupportAction({ action: 'ticket_skill', ticketId: ticket.id, skill: next === '' ? null : next });
      setOutcome(reply);
      setArmed(false);
      // Whatever the answer, read again: after "outcome not known" the page must show what is true.
      setTick((n) => n + 1);
      onDone?.();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <TicketRoutingView
      view={view}
      loading={loading}
      skill={skill}
      armed={armed}
      busy={busy}
      outcome={outcome}
      onSkill={setSkill}
      onArm={(on) => {
        if (!busy) setArmed(on);
      }}
      onSend={() => void send()}
    />
  );
}
