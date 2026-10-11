import { describe, expect, it } from 'vitest';
import { AgentError } from '../errors.js';
import { createHttpNavigatorTradeDataPort, navigatorMarketIdToSymbol, symbolToNavigatorMarketId } from './trade-data-http-port.js';

describe('symbolToNavigatorMarketId', () => {
  it('lowercases and dashes CCXT symbols', () => {
    expect(symbolToNavigatorMarketId('BTC/USDT')).toBe('btc-usdt');
  });
});

describe('navigatorMarketIdToSymbol', () => {
  it('reverses navigator market ids', () => {
    expect(navigatorMarketIdToSymbol('btc-usdt')).toBe('BTC/USDT');
  });
});

describe('createHttpNavigatorTradeDataPort', () => {
  it('maps trade markets and ticker into navigator fixtures', async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === 'http://trade.test/api/v1/markets?limit=50') {
        return new Response(
          JSON.stringify([
            {
              id: 'm-btc-usdt',
              symbol: 'BTC/USDT',
              active: true,
              sessionOpen: true,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/v1/ticker/BTC%2FUSDT')) {
        return new Response(
          JSON.stringify({
            symbol: 'BTC/USDT',
            timestamp: 1_700_000_000_000,
            datetime: '2023-11-14T22:13:20.000Z',
            last: '42000.5',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected url ${url}`);
    };

    const port = createHttpNavigatorTradeDataPort({
      tradeUrl: 'http://trade.test',
      maxAgeMs: 30_000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const markets = await port.listMarkets(50);
    expect(markets).toEqual([{ marketId: 'btc-usdt', symbol: 'BTC/USDT', status: 'open' }]);

    const quote = await port.quote('btc-usdt');
    expect(quote).toMatchObject({
      marketId: 'btc-usdt',
      last: '42000.5',
      asOf: '2023-11-14T22:13:20.000Z',
      maxAgeMs: 30_000,
    });

    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.some((c) => /order|cancel|withdraw/i.test(c.url))).toBe(false);
  });

  it('throws when trade is unreachable — never invented markets', async () => {
    const port = createHttpNavigatorTradeDataPort({
      tradeUrl: 'http://trade.test',
      fetchImpl: (async () => new Response('', { status: 502 })) as typeof fetch,
    });
    await expect(port.listMarkets(50)).rejects.toThrow(/unreachable/);
  });

  it('omit limit refuses agents.navigator_markets_limit_unset — never invent 50 or fetch', async () => {
    const fetchImpl = (async () => {
      throw new Error('must not fetch');
    }) as typeof fetch;
    const port = createHttpNavigatorTradeDataPort({
      tradeUrl: 'http://trade.test',
      fetchImpl,
    });
    await expect(port.listMarkets()).rejects.toBeInstanceOf(AgentError);
    await expect(port.listMarkets()).rejects.toMatchObject({ code: 'agents.navigator_markets_limit_unset' });
  });

  it('constructor marketsLimit reaches the query string when listMarkets omits', async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://trade.test/api/v1/markets?limit=50');
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const port = createHttpNavigatorTradeDataPort({
      tradeUrl: 'http://trade.test',
      marketsLimit: 50,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(port.listMarkets()).resolves.toEqual([]);
  });

  it('owner-published 500 reaches the query string; empty list stays []', async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://trade.test/api/v1/markets?limit=500');
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const port = createHttpNavigatorTradeDataPort({
      tradeUrl: 'http://trade.test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(port.listMarkets(500)).resolves.toEqual([]);
  });

  it('refuses a ticker body whose symbol does not match the symbol on the ticker URL', async () => {
    const fetchImpl = async (url: string) => {
      expect(url).toBe('http://trade.test/api/v1/ticker/BTC%2FUSDT');
      return new Response(
        JSON.stringify({
          symbol: 'ETH/USDT',
          timestamp: 1_700_000_000_000,
          datetime: '2023-11-14T22:13:20.000Z',
          last: '3500.25',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const port = createHttpNavigatorTradeDataPort({
      tradeUrl: 'http://trade.test',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(port.quote('btc-usdt')).rejects.toMatchObject({
      name: 'TradeTickerSymbolMismatchError',
      code: 'trade.ticker_symbol_mismatch',
    });
  });

  it('refuses a matching ticker whose last is blank', async () => {
    for (const last of [null, '', '   '] as const) {
      const fetchImpl = async (url: string) => {
        expect(url).toBe('http://trade.test/api/v1/ticker/BTC%2FUSDT');
        return new Response(
          JSON.stringify({
            symbol: 'BTC/USDT',
            timestamp: 1_700_000_000_000,
            datetime: '2023-11-14T22:13:20.000Z',
            last,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };
      const port = createHttpNavigatorTradeDataPort({
        tradeUrl: 'http://trade.test',
        fetchImpl: fetchImpl as typeof fetch,
      });
      await expect(port.quote('btc-usdt')).rejects.toThrow('trade ticker empty last');
    }
  });
});
