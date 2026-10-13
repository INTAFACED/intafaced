import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../../shared/api';
import type { Draft } from '../../../features/trade/trade-api';
import { resendOrder } from './resend';

const draft: Draft = {
  symbol: 'BTC/USDT',
  side: 'buy',
  type: 'limit',
  amount: '0.0001',
  price: '64000',
  timeInForce: 'GTC',
  postOnly: false,
  clientOrderId: 'desk:abc',
};
const order = (extra: Record<string, unknown> = {}) => ({
  id: 'o1',
  clientOrderId: 'desk:abc',
  timestamp: 1,
  datetime: '2026-10-14T00:00:00.000Z',
  lastTradeTimestamp: null,
  symbol: 'BTC/USDT',
  type: 'limit',
  side: 'buy',
  timeInForce: 'GTC',
  postOnly: false,
  reduceOnly: false,
  price: '64000',
  stopPrice: null,
  average: null,
  amount: '0.0001',
  filled: '0',
  remaining: '0.0001',
  cost: '0',
  status: 'open',
  fee: null,
  trades: [],
  recoveryRequired: false,
  recoveryReason: null,
  reconciliationKey: null,
  ...extra,
});
const clientFor = (respond: () => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  });
  return { client: createApiClient({ fetch: fetchMock as unknown as typeof fetch, token: () => 't' }), calls };
};

describe('resendOrder', () => {
  it('sends one POST carrying the very same draft and clientOrderId', async () => {
    const { client, calls } = clientFor(() => new Response(JSON.stringify(order()), { status: 201 }));
    const result = await resendOrder(client, draft);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(draft);
  });

  it('an answer about another order is unsure, never a success', async () => {
    const other = clientFor(() => new Response(JSON.stringify(order({ clientOrderId: 'desk:other' })), { status: 201 }));
    expect(await resendOrder(other.client, draft)).toEqual({ ok: false, reason: 'unsure' });
  });

  it('a lost answer is unsure, a refusal is a refusal, and neither is retried', async () => {
    const lost = clientFor(() => new Response('upstream', { status: 502 }));
    expect(await resendOrder(lost.client, draft)).toEqual({ ok: false, reason: 'unsure' });
    expect(lost.calls).toHaveLength(1);
    const refused = clientFor(() => new Response(JSON.stringify({ message: 'no', code: 'trade.min_qty_exceeds_qty' }), { status: 400 }));
    expect(await resendOrder(refused.client, draft)).toEqual({ ok: false, reason: 'refused', code: 'trade.min_qty_exceeds_qty' });
    expect(refused.calls).toHaveLength(1);
  });
});
