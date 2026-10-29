'use client';

import { useEffect, useRef, useState } from 'react';
import type { SupportTicket } from '@intafaced/contracts';
import { shortId } from '@/lib/desk/desk-model';
import { fetchCustomerCard, fetchStaff, postSupportAction, type ActionReply } from '@/lib/support/browser';
import { assignKey, unclaimKey } from '@/lib/support/model';
import type { SupportCustomerView, SupportStaffView } from '@/lib/support/types';
import { ActionOutcome, Failed } from './support-action-parts';

/**
 * SP-tickets-09 — who the customer is, and handing a request over.
 *
 * The customer card reads the account's state through svc-support, which records the read on the ticket. "unread" is
 * shown as unread, never as active. A request names no order today, so the related order says "none" from the ticket.
 * Unclaim gives the request back to the queue (only its assignee may); Reassign gives it to another staff member (only a
 * lead may). svc-support is the judge of both and says so when it refuses.
 */

export function CustomerCardView({ card, loading }: { card: SupportCustomerView | null; loading: boolean }) {
  const account = card?.account;
  return (
    <section className="dk-stack" aria-label="Customer" data-testid="customer-card">
      <h4>Customer</h4>
      {!card && <p className="dk-muted">{loading ? 'Reading the account…' : 'The customer card could not be read.'}</p>}
      {account?.kind === 'failed' && <Failed name="Account state" part={account} />}
      {card && (
        <dl className="dk-kv">
          <dt>Account state</dt>
          <dd data-testid="customer-account-state">
            {account?.kind === 'ok' ? (account.data.status === 'read' ? account.data.state.status : 'unread') : 'unread'}
          </dd>
          {account?.kind === 'ok' && account.data.status === 'unread' && (
            <>
              <dt>Why unread</dt>
              <dd>
                {account.data.reason === 'plane_dark'
                  ? 'svc-identity could not be reached from svc-support, so the state is not known.'
                  : 'The account state was not read.'}
              </dd>
            </>
          )}
          {account?.kind === 'ok' && account.data.status === 'read' && (
            <>
              <dt>Verification tier</dt>
              <dd>{account.data.state.kycTier}</dd>
            </>
          )}
          <dt>Related order</dt>
          <dd data-testid="customer-related-order">{card.relatedOrderId ?? 'none'}</dd>
        </dl>
      )}
      {card && card.relatedOrderId === null && <p className="dk-muted">This request names no order: the customer did not attach one.</p>}
    </section>
  );
}

export function TicketHandover({ ticket, userId, onDone }: { ticket: SupportTicket; userId: string; onDone: () => void }) {
  const [card, setCard] = useState<SupportCustomerView | null>(null);
  const [loadingCard, setLoadingCard] = useState(true);
  const [staff, setStaff] = useState<SupportStaffView | null>(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ActionReply | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    let live = true;
    void fetchCustomerCard(ticket.id).then((c) => {
      if (live) {
        setCard(c);
        setLoadingCard(false);
      }
    });
    void fetchStaff().then((s) => live && setStaff(s));
    return () => {
      live = false;
    };
  }, [ticket.id]);

  const mine = ticket.assigneeId !== null && ticket.assigneeId.toLowerCase() === userId.toLowerCase();
  const roster = staff?.roster.kind === 'ok' ? staff.roster.data : null;
  const choices = roster?.filter((m) => m.userId.toLowerCase() !== (ticket.assigneeId ?? '').toLowerCase()) ?? [];

  async function send(request: Parameters<typeof postSupportAction>[0]) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setReply(null);
    try {
      setReply(await postSupportAction(request));
      onDone();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const closed = ticket.status === 'closed';
  return (
    <>
      <CustomerCardView card={card} loading={loadingCard} />
      <section className="dk-stack" aria-label="Hand over" data-testid="ticket-handover">
        <h4>Hand over</h4>
        <p className="dk-muted">
          Owner: {ticket.assigneeId === null ? 'nobody' : mine ? 'you' : shortId(ticket.assigneeId)}. Unclaiming puts the request back in
          the queue; reassigning gives it to another staff member, and only a support lead may.
        </p>
        <div className="dk-row">
          <button
            type="button"
            className="adm-btn"
            disabled={busy || !mine || closed}
            onClick={() => void send({ action: 'unclaim', ticketId: ticket.id, idempotencyKey: unclaimKey(ticket) })}
          >
            Unclaim
          </button>
          {!mine && <span className="dk-why">Only the person the request is with can unclaim it.</span>}
        </div>
        <div className="dk-row">
          <div className="adm-field">
            <label htmlFor={`sd-assign-${ticket.id}`}>Assign to</label>
            <select id={`sd-assign-${ticket.id}`} value={to} onChange={(e) => setTo(e.target.value)} disabled={!roster}>
              <option value="">Choose a staff member</option>
              {choices.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.userId.toLowerCase() === userId.toLowerCase() ? 'You' : shortId(m.userId)} ({m.role}, {m.availability})
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="adm-btn"
            disabled={busy || to === '' || closed}
            onClick={() => void send({ action: 'assign', ticketId: ticket.id, assigneeId: to, idempotencyKey: assignKey(ticket, to) })}
          >
            Reassign
          </button>
          {!roster && <span className="dk-why">The staff list could not be read, so there is nobody to choose.</span>}
        </div>
        <ActionOutcome reply={reply} testId="handover-outcome" />
      </section>
    </>
  );
}
