'use client';

import { useEffect, useRef, useState } from 'react';
import type { SupportTicket, SupportTicketEvent } from '@intafaced/contracts';
import { shortId } from '@/lib/desk/desk-model';
import type { Part } from '@/lib/desk/part';
import { fetchStaff, postSupportAction, type ActionReply } from '@/lib/support/browser';
import type { StaffMemberView } from '@/lib/support/staff';
import { lastSequence } from '@/lib/support/trail';
import { ActionOutcome } from './support-action-parts';

/**
 * WHO HOLDS THIS REQUEST — the holder hands it back to the queue, and a lead gives it to someone on the staff list.
 *
 * svc-support is the judge of both: only the holder may unclaim, and only a lead may give a request to someone else. Its
 * refusal is shown with its code and nothing changes. Each change is written to the request's history by svc-support.
 */
export function TicketOwner({
  ticket,
  events,
  userId,
  onDone,
}: {
  ticket: SupportTicket;
  events: Part<readonly SupportTicketEvent[]>;
  userId: string;
  onDone: () => void;
}) {
  const [roster, setRoster] = useState<readonly StaffMemberView[] | null>(null);
  const [rosterWhy, setRosterWhy] = useState<string | null>(null);
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionReply | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    void fetchStaff(abort.signal).then((view) => {
      if (abort.signal.aborted) return;
      if (view && view.roster.kind === 'ok') setRoster(view.roster.data);
      else setRosterWhy(view && view.roster.kind === 'failed' ? view.roster.message : 'The staff list could not be read.');
    });
    return () => abort.abort();
  }, []);

  const holder = ticket.assigneeId;
  const mine = holder !== null && holder.toLowerCase() === userId.toLowerCase();
  // The business key of each change is the trail row it was made from; without the trail there is no safe key.
  const seen = events.kind === 'ok' ? lastSequence(events.data) : null;
  const trailWhy = seen === null ? 'The ticket history could not be read. Read the ticket again first.' : null;
  const unclaimWhy =
    trailWhy ?? (holder === null ? 'Nobody holds this request.' : !mine ? 'Only the person holding it can unclaim it.' : null);
  const assignWhy = trailWhy ?? (assignee === '' ? 'Choose who gets it.' : null);

  async function send(request: Parameters<typeof postSupportAction>[0]) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await postSupportAction(request));
      // Whatever the answer, read the request again: the holder shown must be svc-support's.
      onDone();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="dk-stack" aria-label="Who holds this request" data-testid="ticket-owner">
      <h4>Who holds this request</h4>
      <p data-testid="ticket-holder" data-user-id={holder ?? undefined}>
        {holder === null ? 'Nobody: it is in the queue.' : mine ? 'You' : shortId(holder)}
      </p>
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          disabled={busy || unclaimWhy !== null}
          onClick={() => void send({ action: 'unclaim', ticketId: ticket.id, expectedSequence: seen ?? 0 })}
        >
          {busy ? 'Sending…' : 'Unclaim'}
        </button>
        {unclaimWhy && <span className="dk-why">{unclaimWhy}</span>}
      </div>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor={`sd-assign-${ticket.id}`}>Assign to</label>
          <select
            id={`sd-assign-${ticket.id}`}
            className="adm-input"
            value={assignee}
            disabled={busy || roster === null}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">{roster === null ? (rosterWhy ?? 'Reading the staff list…') : 'Choose a person'}</option>
            {(roster ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {shortId(m.userId)} · {m.role}
                {m.userId.toLowerCase() === userId.toLowerCase() ? ' (you)' : ''}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="adm-btn"
          disabled={busy || assignWhy !== null}
          onClick={() => void send({ action: 'assign', ticketId: ticket.id, assigneeId: assignee, expectedSequence: seen ?? 0 })}
        >
          Reassign
        </button>
        {assignWhy && <span className="dk-why">{assignWhy}</span>}
      </div>
      <p className="dk-muted">Only a lead can give a request to someone else; svc-support refuses anyone else and nothing changes.</p>
      <ActionOutcome reply={outcome} testId="owner-outcome" />
    </section>
  );
}
