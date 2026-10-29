'use client';

import { useEffect, useRef, useState } from 'react';
import type { SupportTicket } from '@intafaced/contracts';
import { shortId } from '@/lib/desk/desk-model';
import { fetchStaff, postSupportAction, type ActionReply } from '@/lib/support/browser';
import { assignmentKey, isTicketId } from '@/lib/support/model';
import type { SupportStaffView } from '@/lib/support/types';
import { ActionOutcome, Failed } from './support-action-parts';

/**
 * WHO HOLDS IT — unclaim this request, or give it to someone else.
 *
 * One click each: both can be undone from here. svc-support lets only the assignee unclaim and only a lead reassign to
 * another person; anyone else is refused, and the refusal is shown as svc-support gave it. The choice of person comes from
 * svc-support's staff roster. Each move is logged on the request's trail.
 */

export interface TicketAssignmentViewProps {
  readonly ticket: Pick<SupportTicket, 'id' | 'assigneeId' | 'status'>;
  readonly userId: string;
  readonly staff: SupportStaffView | null;
  readonly target: string;
  readonly busy: boolean;
  readonly outcome: ActionReply | null;
  readonly onTarget: (id: string) => void;
  readonly onUnclaim: () => void;
  readonly onReassign: () => void;
}

export function TicketAssignmentView(p: TicketAssignmentViewProps) {
  const t = p.ticket;
  const mine = t.assigneeId !== null && t.assigneeId.toLowerCase() === p.userId.toLowerCase();
  const roster = p.staff?.roster.kind === 'ok' ? p.staff.roster.data : [];
  const sameAsNow = t.assigneeId !== null && p.target.toLowerCase() === t.assigneeId.toLowerCase();
  const why = !isTicketId(p.target)
    ? 'Choose who should hold it.'
    : sameAsNow
      ? 'That person already holds it.'
      : null;
  return (
    <section className="dk-stack" aria-label="Who holds this request" data-testid="ticket-assignment">
      <h4>Who holds it</h4>
      {mine ? (
        <div className="dk-row">
          <button type="button" className="adm-btn" onClick={p.onUnclaim} disabled={p.busy}>
            Unclaim
          </button>
          <span className="dk-muted">It goes back to the queue for anyone to claim.</span>
        </div>
      ) : (
        <p className="dk-muted">
          {t.assigneeId === null ? 'Nobody holds it.' : `${shortId(t.assigneeId)} holds it; only they can unclaim it.`}
        </p>
      )}
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor={`sd-assign-${t.id}`}>Assign to</label>
          <select
            id={`sd-assign-${t.id}`}
            className="adm-input"
            value={p.target}
            onChange={(e) => p.onTarget(e.target.value)}
            disabled={p.busy}
          >
            <option value="">Choose a person</option>
            {roster.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.role} {shortId(m.userId)}
                {m.userId.toLowerCase() === p.userId.toLowerCase() ? ' (you)' : ''} · {m.availability}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="adm-btn" onClick={p.onReassign} disabled={p.busy || why !== null}>
          {p.busy ? 'Sending…' : 'Reassign'}
        </button>
        {why && <span className="dk-why">{why}</span>}
      </div>
      <p className="dk-muted">Only a support lead may give a request to someone else; svc-support refuses anyone else.</p>
      {!p.staff && <p className="dk-why">The staff roster could not be read, so there is nobody to choose.</p>}
      {p.staff && p.staff.roster.kind === 'failed' && <Failed name="Staff roster" part={p.staff.roster} />}
      <ActionOutcome reply={p.outcome} testId="assignment-outcome" />
    </section>
  );
}

export function TicketAssignment({
  ticket,
  userId,
  onDone,
}: {
  readonly ticket: Pick<SupportTicket, 'id' | 'assigneeId' | 'status' | 'updatedAt'>;
  readonly userId: string;
  readonly onDone: () => void;
}) {
  const [staff, setStaff] = useState<SupportStaffView | null>(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionReply | null>(null);
  const lock = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    void fetchStaff(abort.signal).then((next) => {
      if (!abort.signal.aborted) setStaff(next);
    });
    return () => abort.abort();
  }, []);
  async function send(kind: 'unclaim' | 'assign') {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      const reply =
        kind === 'unclaim'
          ? await postSupportAction({
              action: 'unclaim',
              ticketId: ticket.id,
              idempotencyKey: assignmentKey('unclaim', ticket.id, ticket.updatedAt),
            })
          : await postSupportAction({
              action: 'assign',
              ticketId: ticket.id,
              assigneeId: target,
              idempotencyKey: assignmentKey('assign', ticket.id, ticket.updatedAt, target),
            });
      setOutcome(reply);
      if (reply.ok) setTarget('');
      onDone();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <TicketAssignmentView
      ticket={ticket}
      userId={userId}
      staff={staff}
      target={target}
      busy={busy}
      outcome={outcome}
      onTarget={setTarget}
      onUnclaim={() => void send('unclaim')}
      onReassign={() => void send('assign')}
    />
  );
}
