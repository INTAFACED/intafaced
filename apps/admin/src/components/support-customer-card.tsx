'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAsOf } from '@/lib/as-of';
import { fetchCustomerCard } from '@/lib/support/browser';
import type { SupportCustomerView } from '@/lib/support/types';

/** What the card says about the account: svc-identity's state when it was read, else "unread" — never a guessed "active". */
export function accountWords(view: SupportCustomerView | null): { state: string; why: string | null; code: string | null } {
  if (!view) return { state: 'unread', why: 'The console could not reach svc-support for the account.', code: null };
  const a = view.account;
  if (a.kind === 'failed') return { state: 'unread', why: a.message, code: a.code ?? null };
  if (a.data.status === 'unread') {
    return {
      state: 'unread',
      why: a.data.reason === 'plane_dark' ? 'svc-identity could not be reached, so the account state is not known.' : 'Not read.',
      code: a.data.reason,
    };
  }
  return { state: a.data.state.status, why: null, code: null };
}

/** What the card says about the related order: the orders the desk linked, "none" only when it read none, else "unread". */
export function orderWords(view: SupportCustomerView | null): { order: string; why: string | null; code: string | null } {
  if (!view) return { order: 'unread', why: 'The console could not reach svc-support for the related orders.', code: null };
  if (view.orders.kind === 'failed') return { order: 'unread', why: view.orders.message, code: view.orders.code ?? null };
  if (view.orders.data.length === 0) return { order: 'none', why: 'This request names no order.', code: null };
  return { order: view.orders.data.join(', '), why: null, code: null };
}

/**
 * CUSTOMER — the account behind the request, read through svc-support when the request is opened. svc-support takes the
 * account from the request itself, so the card cannot be pointed at anyone else, and it records the read in the
 * request's history.
 */
export function CustomerCard({ ticketId }: { ticketId: string }) {
  const [view, setView] = useState<SupportCustomerView | null>(null);
  const [reading, setReading] = useState(true);
  const seq = useRef(0);

  const read = useCallback(async () => {
    const mine = ++seq.current;
    setReading(true);
    const next = await fetchCustomerCard(ticketId);
    if (mine === seq.current) {
      setView(next);
      setReading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    void read();
  }, [read]);

  const words = accountWords(view);
  const related = orderWords(view);
  const tier = view && view.account.kind === 'ok' && view.account.data.status === 'read' ? view.account.data.state.kycTier : null;
  return (
    <section className="dk-stack" aria-label="Customer" data-testid="customer-card">
      <div className="dk-row">
        <h4>Customer</h4>
        <button type="button" className="adm-btn" onClick={() => void read()} disabled={reading}>
          {reading ? 'Reading…' : 'Read again'}
        </button>
        {view && <span className="dk-asof">As of {formatAsOf(view.asOf)}</span>}
      </div>
      <dl className="dk-kv">
        <dt>Account state</dt>
        <dd>
          {reading && !view ? (
            <span className="dk-muted">Reading…</span>
          ) : (
            <>
              <span data-testid="customer-account-state" data-code={words.code ?? undefined}>
                {words.state}
              </span>
              {tier !== null && <span className="dk-muted"> · verification tier {String(tier)}</span>}
              {words.why && <span className="dk-why"> {words.why}</span>}
            </>
          )}
        </dd>
        <dt>Related order</dt>
        <dd>
          {reading && !view ? (
            <span className="dk-muted">Reading…</span>
          ) : (
            <>
              <span data-testid="customer-related-order" data-code={related.code ?? undefined}>
                {related.order}
              </span>
              {related.why && <span className="dk-muted"> {related.why}</span>}
            </>
          )}
        </dd>
      </dl>
    </section>
  );
}
