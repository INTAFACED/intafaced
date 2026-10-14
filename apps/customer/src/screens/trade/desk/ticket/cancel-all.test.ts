import { describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../../../shared/api';
import { cancelAllOrders, countBySymbol } from './cancel-all';

const order = (id: string, symbol: string, status: string, patch: Record<string, unknown> = {}) => ({
  id,
  clientOrderId: `c-${id}`,
  timestamp: 1,
  datetime: new Date(1).toISOString(),
  lastTradeTimestamp: null,
  symbol,
  type: 'limit',
  side: 'buy',
  timeInForce: 'GTC',
  postOnly: false,
  reduceOnly: false,
  price: '100',
  stopPrice: null,
  average: null,
  amount: '1',
  filled: '0',
  remaining: '1',
  cost: '0',
  status,
  fee: null,
  trades: [],
  recoveryRequired: false,
  recoveryReason: null,
  reconciliationKey: null,
  ...patch,
});
const clientWith = (answer: ApiResult<unknown>) => {
  const rest = vi.fn(async (_path: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }) => {
    if (!answer.ok) return answer;
    const parsed = schema.safeParse(answer.data);
    return parsed.success
      ? { ok: true as const, data: parsed.data }
      : { ok: false as const, reason: 'uncertain' as const, message: 'unreadable' };
  });
  return { client: { rest } as unknown as ApiClient, rest };
};

describe('cancel all', () => {
  it('is one DELETE: no body, the market in the query when one is chosen', async () => {
    const { client, rest } = clientWith({ ok: true, data: [order('1', 'BTC/USDT', 'canceled')] });
    await cancelAllOrders(client, 'BTC/USDT');
    expect(rest).toHaveBeenCalledTimes(1);
    expect(rest).toHaveBeenCalledWith('/orders', expect.anything(), { method: 'DELETE', query: { symbol: 'BTC/USDT' } });
    await cancelAllOrders(client);
    expect(rest).toHaveBeenLastCalledWith('/orders', expect.anything(), { method: 'DELETE', query: { symbol: undefined } });
  });

  it('counts the orders that were cancelled, not ones that filled first', async () => {
    const { client } = clientWith({
      ok: true,
      data: [
        order('1', 'BTC/USDT', 'canceled'),
        order('2', 'BTC/USDT', 'canceled'),
        order('3', 'BTC/USDT', 'closed', { filled: '1', remaining: '0' }),
      ],
    });
    expect(await cancelAllOrders(client)).toEqual({ kind: 'done', cancelled: 2 });
  });

  it('nothing to cancel is a clean zero', async () => {
    expect(await cancelAllOrders(clientWith({ ok: true, data: [] }).client)).toEqual({ kind: 'done', cancelled: 0 });
  });

  it('an order that has not ended, or still needs recovery, is not a clean answer', async () => {
    expect(await cancelAllOrders(clientWith({ ok: true, data: [order('1', 'BTC/USDT', 'open')] }).client)).toEqual({ kind: 'unsure' });
    expect(
      await cancelAllOrders(
        clientWith({ ok: true, data: [order('1', 'BTC/USDT', 'canceled', { recoveryRequired: true, recoveryReason: 'x' })] }).client,
      ),
    ).toEqual({ kind: 'unsure' });
  });

  it('an answer about another market than the one asked for is not trusted', async () => {
    const { client } = clientWith({ ok: true, data: [order('1', 'ETH/USDT', 'canceled')] });
    expect(await cancelAllOrders(client, 'BTC/USDT')).toEqual({ kind: 'unsure' });
  });

  it('a lost answer is "not sure": some orders may be cancelled', async () => {
    expect(await cancelAllOrders(clientWith({ ok: false, reason: 'uncertain', message: 'lost' }).client)).toEqual({ kind: 'unsure' });
  });

  it('a refusal is reported as failed, with its code', async () => {
    expect(await cancelAllOrders(clientWith({ ok: false, reason: 'forbidden', message: 'no', code: 'scope.denied' }).client)).toEqual({
      kind: 'failed',
      code: 'scope.denied',
    });
  });

  it('counts open orders per market for the confirmation', () => {
    expect(countBySymbol([{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }, { symbol: 'BTC/USDT' }])).toEqual([
      { symbol: 'BTC/USDT', count: 2 },
      { symbol: 'ETH/USDT', count: 1 },
    ]);
  });
});
