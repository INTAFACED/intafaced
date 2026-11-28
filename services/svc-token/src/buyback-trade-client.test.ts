import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createTradeIocMarketBuy } from './buyback-trade-client.js';

const SECRET = 'test-internal-secret-for-buyback-place';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTradeIocMarketBuy', () => {
  it('unset symbol refuses — never invents a listing or a fill', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const place = createTradeIocMarketBuy({ tradeUrl: 'http://trade.test', symbol: '', internalSecret: SECRET });
    await expect(place({ quoteBudget: amt('50'), clientOrderId: 'run-1' })).rejects.toMatchObject({
      code: 'token.buyback_job_unset',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('empty asks → filledQty 0 and never POSTs a placeOrder', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain('/api/v1/orderbook/');
      return { ok: true, json: async () => ({ asks: [] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const place = createTradeIocMarketBuy({ tradeUrl: 'http://trade.test', symbol: 'IFC/USDT', internalSecret: SECRET });
    await expect(place({ quoteBudget: amt('50'), clientOrderId: 'run-1' })).resolves.toEqual({ filledQty: 0n });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('non-empty book refuses unpublished — never POSTs USER REST /api/v1/orders, never invents a fill', async () => {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      expect(String(url)).toContain('/api/v1/orderbook/');
      expect(init?.method ?? 'GET').not.toBe('POST');
      expect(String(url)).not.toContain('/api/v1/orders');
      return { ok: true, json: async () => ({ asks: [['2', '100']] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const place = createTradeIocMarketBuy({ tradeUrl: 'http://trade.test', symbol: 'IFC/USDT', internalSecret: SECRET });
    await expect(place({ quoteBudget: amt('50'), clientOrderId: 'run-1' })).rejects.toMatchObject({
      code: 'token.buyback_job_unset',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.every(([url, init]) => !String(url).includes('/api/v1/orders') && init?.method !== 'POST')).toBe(true);
  });

  it('non-empty book does not invent a fill from depth when place is unpublished', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain('/orderbook/');
      return { ok: true, json: async () => ({ asks: [['2', '100']] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const place = createTradeIocMarketBuy({ tradeUrl: 'http://trade.test', symbol: 'IFC/USDT', internalSecret: SECRET });
    await expect(place({ quoteBudget: amt('50'), clientOrderId: 'run-1' })).rejects.toMatchObject({
      code: 'token.buyback_job_unset',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
