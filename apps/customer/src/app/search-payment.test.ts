import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../shared/api';
import { findPayment, paymentHref, paymentId } from './search-payment';

const ID = '042f94a7-5249-42de-8db9-c71db25a5fa0';
const payment = {
  id: ID,
  customerRef: 'TEST-1',
  merchantId: '11111111-1111-4111-8111-111111111111',
  profileId: null,
  amount: '12.00',
  assetId: 'USDT',
  method: 'card',
  railAdapter: 'card-sandbox',
  railRef: null,
  status: 'captured',
  capturedAmount: '12.00',
  refundedAmount: '0',
  createdAt: '2026-10-29T05:00:00.000Z',
};
const api = (answer: ApiResult<unknown>) => {
  const calls: unknown[][] = [];
  const query = (async (...args: unknown[]) => {
    calls.push(args);
    return answer;
  }) as unknown as ApiClient['query'];
  return { client: { query }, calls };
};
const refused = (status: number, code?: string): ApiResult<unknown> => ({
  ok: false,
  reason: 'error',
  message: 'refused',
  status,
  ...(code ? { code } : {}),
});
const signal = new AbortController().signal;

describe('header search: a merchant payment by id (J-home-ia-02 #7)', () => {
  it('takes only a full payment id, in any case and with spaces around it', () => {
    expect(paymentId(` ${ID.toUpperCase()} `)).toBe(ID);
    expect(paymentId(ID.slice(0, 20))).toBeNull();
    expect(paymentId('payouts')).toBeNull();
    expect(paymentHref(ID)).toBe(`/pay/payments/${ID}`);
  });

  it('finds the payment with svc-pay payment.get', async () => {
    const { client, calls } = api({ ok: true, data: payment });
    await expect(findPayment(client, ID, signal)).resolves.toEqual({ status: 'ready', payment });
    expect(calls[0]?.slice(0, 3)).toEqual(['pay', 'payment.get', { paymentId: ID }]);
  });

  it('reads not found and refused as none, so it never says whose payment an id is', async () => {
    await expect(findPayment(api(refused(404, 'NOT_FOUND')).client, ID, signal)).resolves.toEqual({ status: 'none' });
    await expect(findPayment(api(refused(403, 'FORBIDDEN')).client, ID, signal)).resolves.toEqual({ status: 'none' });
  });

  it('reads a gateway refusal, an unwired route or a lost answer as failed, never as none', async () => {
    await expect(findPayment(api(refused(404)).client, ID, signal)).resolves.toEqual({ status: 'failed' });
    await expect(findPayment(api(refused(403, 'edge.screening_unset')).client, ID, signal)).resolves.toEqual({ status: 'failed' });
    await expect(findPayment(api(refused(503)).client, ID, signal)).resolves.toEqual({ status: 'failed' });
  });

  it('does not show a payment whose id is not the one searched', async () => {
    const other = { ...payment, id: '142f94a7-5249-42de-8db9-c71db25a5fa0' };
    await expect(findPayment(api({ ok: true, data: other }).client, ID, signal)).resolves.toEqual({ status: 'none' });
  });
});
