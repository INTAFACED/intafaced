'use client';

import { useEffect, useState } from 'react';
import type { SupportAccountGrounding } from '@intafaced/contracts';
import { shortId } from '@/lib/desk/desk-model';
import { formatWhen } from '@/lib/as-of';
import { fetchCustomerCard } from '@/lib/support/browser';
import type { CustomerCardView } from '@/lib/support/types';
import { Failed } from './support-action-parts';

/**
 * CUSTOMER CARD — who sent this request, as far as the desk can say.
 *
 * The account state is svc-support's `accountState` read for this ticket's owner (svc-support asks svc-identity and logs
 * the read on the ticket's trail). When identity cannot be reached, or the read itself fails, the state is "unread" with
 * the reason: never "active". A request carries no order link in svc-support, so the related order is "none".
 */

const UNREAD_WHY: Record<Extract<SupportAccountGrounding, { status: 'unread' }>['reason'], string> = {
  plane_dark: 'svc-support could not reach the identity service, so the account state was not read.',
  not_attempted: 'svc-support did not read the account state.',
};

export function TicketCustomerView({
  userId,
  card,
  loading,
}: {
  readonly userId: string;
  readonly card: CustomerCardView | null;
  readonly loading: boolean;
}) {
  const account = card?.account ?? null;
  return (
    <section className="dk-stack" aria-label="Customer" data-testid="ticket-customer">
      <h4>Customer</h4>
      <dl className="dk-kv">
        <dt>Customer account id</dt>
        <dd>
          <span className="dk-packet" title={userId}>
            {shortId(userId)}
          </span>{' '}
          <span className="dk-muted" data-testid="customer-no-handle">
            No handle: svc-identity has no operator read that names an account from its id (back-end need 47).
          </span>
        </dd>
        <dt>Account state</dt>
        <dd>
          {loading && !card ? (
            <span className="dk-muted">Reading…</span>
          ) : account && account.kind === 'ok' && account.data.status === 'read' ? (
            <>
              <strong data-testid="customer-account-state">{account.data.state.status}</strong>{' '}
              <span className="dk-muted">
                KYC tier {account.data.state.kycTier}; read from the identity service {formatWhen(account.data.readAt)}.
              </span>
            </>
          ) : (
            <>
              <strong data-testid="customer-account-state">unread</strong>{' '}
              <span className="dk-muted" data-testid="customer-account-why">
                {account && account.kind === 'ok' && account.data.status === 'unread'
                  ? UNREAD_WHY[account.data.reason]
                  : 'svc-support did not answer the read, so the account state is not known.'}
              </span>
            </>
          )}
        </dd>
        <dt>Related order</dt>
        <dd>
          <strong data-testid="customer-related-order">none</strong>{' '}
          <span className="dk-muted">
            A request carries no order link in svc-support; an order the customer names is in the conversation.
          </span>
        </dd>
      </dl>
      {account && account.kind === 'failed' && <Failed name="Account state" part={account} />}
    </section>
  );
}

/** Reads the card once per opened ticket: each read is logged on the ticket's trail, so it is not repeated on every refresh. */
export function TicketCustomer({ ticketId, userId }: { readonly ticketId: string; readonly userId: string }) {
  const [card, setCard] = useState<CustomerCardView | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    void fetchCustomerCard(ticketId, abort.signal).then((next) => {
      if (abort.signal.aborted) return;
      setCard(next);
      setLoading(false);
    });
    return () => abort.abort();
  }, [ticketId]);
  return <TicketCustomerView userId={userId} card={card} loading={loading} />;
}
