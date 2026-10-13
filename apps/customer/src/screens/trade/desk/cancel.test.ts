import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../../shared/api';
import { cancelOrder } from './cancel';

const order = (extra: Record<string, unknown> = {}) => ({
  id: 'o1',
  clientOrderId: 'desk:1',
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
  status: 'canceled',
  fee: null,
  trades: [],
  recoveryRequired: false,
  recoveryReason: null,
  reconciliationKey: null,
  ...extra,
});
const clientFor = (respond: (init: RequestInit) => Response) => {
  const calls: RequestInit[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init);
    return respond(init);
  });
  return { client: createApiClient({ fetch: fetchMock as unknown as typeof fetch, token: () => 't' }), calls, fetchMock };
};

describe('cancelOrder', () => {
  it('sends one DELETE with a body, because the service refuses a JSON DELETE with none', async () => {
    const { client, calls } = clientFor(() => new Response(JSON.stringify(order()), { status: 200 }));
    const result = await cancelOrder(client, { id: 'o1', symbol: 'BTC/USDT' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.body).toBe('{}');
  });

  it('treats an answer about another order, or one that is not final, as unknown', async () => {
    const other = clientFor(() => new Response(JSON.stringify(order({ id: 'o2' })), { status: 200 }));
    expect(await cancelOrder(other.client, { id: 'o1', symbol: 'BTC/USDT' })).toEqual({ ok: false, reason: 'uncertain' });
    const open = clientFor(() => new Response(JSON.stringify(order({ status: 'open' })), { status: 200 }));
    expect(await cancelOrder(open.client, { id: 'o1', symbol: 'BTC/USDT' })).toEqual({ ok: false, reason: 'uncertain' });
  });

  it('a refusal is a refusal and a server error is unknown; neither is retried', async () => {
    const refused = clientFor(
      () => new Response(JSON.stringify({ error: { message: 'no', code: 'trade.order_not_found' } }), { status: 404 }),
    );
    expect(await cancelOrder(refused.client, { id: 'o1', symbol: 'BTC/USDT' })).toEqual({ ok: false, reason: 'refused' });
    expect(refused.calls).toHaveLength(1);
    const broken = clientFor(() => new Response('upstream', { status: 502 }));
    expect(await cancelOrder(broken.client, { id: 'o1', symbol: 'BTC/USDT' })).toEqual({ ok: false, reason: 'uncertain' });
    expect(broken.calls).toHaveLength(1);
  });
});
