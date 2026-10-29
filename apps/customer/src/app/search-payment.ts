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
  /** No payment of this business has that id (or it belongs to someone else: svc-pay does not say which). */
  | { status: 'none' }
  | { status: 'failed' };

export const paymentId = (query: string): string | null => {
  const q = query.trim();
  return PAYMENT_ID.test(q) ? q.toLowerCase() : null;
};

/** Where a payment's record opens in the merchant portal. */
export const paymentHref = (id: string) => `/pay/payments/${encodeURIComponent(id)}`;

/**
 * One lookup. svc-pay's not found and refused both read as none, so the search never says whose payment an id is. A
 * 404 or 403 without the service's own code (a route the gateway has not wired, or the gateway refusing) is a failure.
 */
export async function findPayment(api: Pick<ApiClient, 'query'>, id: string, signal: AbortSignal): Promise<PaymentState> {
  const answer = await api.query('pay', 'payment.get', { paymentId: id }, paymentSchema, { signal });
  if (answer.ok) return answer.data.id.toLowerCase() === id ? { status: 'ready', payment: answer.data } : { status: 'none' };
  const serviceSaidNo = (answer.status === 404 || answer.status === 403) && answer.code !== undefined && !answer.code.startsWith('edge.');
  return serviceSaidNo ? { status: 'none' } : { status: 'failed' };
}

export function usePaymentSearch(query: string, enabled: boolean): PaymentState {
  const api = useApi();
  const [state, setState] = useState<PaymentState>({ status: 'idle' });
  const id = enabled ? paymentId(query) : null;
  useEffect(() => {
    if (!id) return setState({ status: 'idle' });
    const controller = new AbortController();
    setState({ status: 'loading' });
    findPayment(api, id, controller.signal)
      .then((next) => !controller.signal.aborted && setState(next))
      .catch(() => !controller.signal.aborted && setState({ status: 'failed' }));
    return () => controller.abort();
  }, [api, id]);
  return state;
}
