'use client';

import { useEffect, useState } from 'react';
import type { SupportTicket, SupportWaitingOn } from '@intafaced/contracts';
import { fetchTicketLifecycle } from '@/lib/support/browser';
import type { SupportLifecycleView } from '@/lib/support/types';
import { formatWhen } from '@/lib/as-of';
import { Failed } from './support-action-parts';

/**
 * WHO THE TICKET WAITS ON — read-only, staff only.
 *
 * svc-support keeps this beside the ticket, so the customer's own read of their request never carries it. Nothing set
 * yet reads "Nobody yet", never a guessed side. It changes by itself: an agent reply puts the ticket on the customer,
 * a customer reply puts it back on the team.
 */

const WAITING: Readonly<Record<SupportWaitingOn, string>> = { team: 'The support team', customer: 'The customer' };

export interface TicketLifecycleViewProps {
  readonly ticket: Pick<SupportTicket, 'id' | 'status'>;
  readonly view: SupportLifecycleView | null;
  readonly loading: boolean;
}

export function TicketLifecycleView({ ticket, view, loading }: TicketLifecycleViewProps) {
  const part = view?.lifecycle;
  const current = part?.kind === 'ok' ? part.data : null;
  return (
    <section className="dk-stack" aria-label="Waiting on" data-testid="ticket-lifecycle">
      <h4>Waiting on</h4>
      <p className="dk-muted">Only support staff see this. The customer’s own view of the request does not carry it.</p>
      {!view ? (
        <p className="dk-muted">{loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : part?.kind === 'failed' ? (
        <Failed name="Waiting on" part={part} />
      ) : current ? (
        <dl className="dk-kv">
          <dt>Waiting on</dt>
          <dd data-testid="life-waiting-on">
            {ticket.status === 'on_hold' ? 'On hold by the team' : current.waitingOn ? WAITING[current.waitingOn] : 'Nobody yet'}
          </dd>
          <dt>Since</dt>
          <dd data-testid="life-since">{current.waitingSince ? formatWhen(current.waitingSince) : '—'}</dd>
          <dt>First public reply</dt>
          <dd data-testid="life-first-reply">{current.firstPublicReplyAt ? formatWhen(current.firstPublicReplyAt) : 'None yet'}</dd>
          <dt>Follows request</dt>
          <dd data-testid="life-follows">{current.followsTicketId ?? 'None'}</dd>
        </dl>
      ) : null}
    </section>
  );
}

/** Reads again when the ticket changes (the page reloads the ticket after every action, so its status or update time moves). */
export function TicketLifecycle({ ticket }: { ticket: Pick<SupportTicket, 'id' | 'status' | 'updatedAt'> }) {
  const [view, setView] = useState<SupportLifecycleView | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetchTicketLifecycle(ticket.id, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setView(next);
      setLoading(false);
    });
    return () => controller.abort();
  }, [ticket.id, ticket.status, ticket.updatedAt]);
  return <TicketLifecycleView ticket={ticket} view={view} loading={loading} />;
}
