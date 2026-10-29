import { useEffect, useState } from 'react';
import type { ApiClient } from '../shared/api';
import { useApi } from '../features/session/session';
import { paymentSchema, type Payment } from '../features/pay/schemas';

/**
 * The Payments group of the header search (J-home-ia-02 #7). In Business mode a merchant payment id typed or pasted in
 * full is looked up with svc-pay's `payment.get`, which answers only for the signed-in owner's own merchants. Nothing
 * else is searched: a partial id, a Personal profile or a signed-out visit never calls the service.
 */
const PAYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PaymentState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; payment: Payment }
  /** None of this person's merchants has a payment with that id (svc-pay answers another owner's payment the same way). */
  | { status: 'none' }
  | { status: 'failed' };

export const paymentId = (query: string): string | null => {
  const q = query.trim();
  return PAYMENT_ID.test(q) ? q.toLowerCase() : null;
};

/** Where a payment's record opens in the merchant portal. */
export const paymentHref = (id: string) => `/pay/payments/${encodeURIComponent(id)}`;

/**
 * One lookup. Only svc-pay's own not found reads as none (it answers another owner's payment the same way, so the search
 * never says whose an id is). Anything else, a refusal with a named blocker, a route the gateway has not wired or a
 * lost answer, is a failure the panel names, never "no results".
 */
export async function findPayment(api: Pick<ApiClient, 'query'>, id: string, signal: AbortSignal): Promise<PaymentState> {
  const answer = await api.query('pay', 'payment.get', { paymentId: id }, paymentSchema, { signal });
  if (answer.ok) return answer.data.id.toLowerCase() === id ? { status: 'ready', payment: answer.data } : { status: 'none' };
  return answer.status === 404 && answer.code === 'NOT_FOUND' ? { status: 'none' } : { status: 'failed' };
}

/**
 * The lookup for the search box. `scope` names the profile in view: a new profile asks again. An answer is kept with the
 * id and profile it answers, so until the next answer arrives an older one reads as loading, never as this id's payment.
 */
export function usePaymentSearch(query: string, scope: string | null): PaymentState {
  const api = useApi();
  const [answer, setAnswer] = useState<{ key: string; state: PaymentState } | null>(null);
  const id = scope ? paymentId(query) : null;
  const key = id ? `${scope}:${id}` : null;
  useEffect(() => {
    if (!id || !key) return;
    const controller = new AbortController();
    findPayment(api, id, controller.signal)
      .then((state) => !controller.signal.aborted && setAnswer({ key, state }))
      .catch(() => !controller.signal.aborted && setAnswer({ key, state: { status: 'failed' } }));
    return () => controller.abort();
  }, [api, id, key]);
  if (!key) return { status: 'idle' };
  return answer?.key === key ? answer.state : { status: 'loading' };
}
