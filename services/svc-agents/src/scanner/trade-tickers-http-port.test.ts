import { describe, expect, it } from 'vitest';
import { AgentError } from '../errors.js';
import { createHttpSpotTickersPort, symbolToScannerMarketId } from './trade-tickers-http-port.js';

describe('symbolToScannerMarketId', () => {
  it('lowercases and dashes CCXT symbols', () => {
    expect(symbolToScannerMarketId('BTC/USDT')).toBe('btc-usdt');
  });
});

describe('createHttpSpotTickersPort', () => {
  it('maps trade tickers record into scanner fixtures', async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://trade.test/api/v1/tickers?limit=50');
      return new Response(
        JSON.stringify({
          'BTC/USDT': {
            symbol: 'BTC/USDT',
            timestamp: 1_700_000_000_000,
            datetime: '2023-11-14T22:13:20.000Z',
            high: null,
            low: null,
            bid: '42000',
            bidVolume: null,
            ask: '42001',
            askVolume: null,
            vwap: null,
            open: null,
            close: null,
            last: '42000.5',
            previousClose: null,
            change: null,
            percentage: '1.25',
            average: null,
            baseVolume: null,
            quoteVolume: '1000000',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const port = createHttpSpotTickersPort({
      tradeUrl: 'http://trade.test',
      maxAgeMs: 30_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tickers = await port.sample(50);
    expect(tickers).toHaveLength(1);
    expect(tickers[0]).toMatchObject({
      marketId: 'btc-usdt',
      last: '42000.5',
      volume24h: '1000000',
      change24hBps: 125,
      maxAgeMs: 30_000,
    });
  });

  it('drops a ticker whose symbol names a different instrument than its key', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          'ETH/USDT': {
            symbol: 'BTC/USDT',
            timestamp: 1_700_000_000_000,
            last: '99999.1',
            quoteVolume: '1',
            baseVolume: null,
            percentage: null,
          },
          'BTC/USDT': {
            symbol: 'btc/usdt',
            timestamp: 1_700_000_000_000,
            last: '42000.5',
            quoteVolume: '1000000',
            baseVolume: null,
            percentage: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const port = createHttpSpotTickersPort({
      tradeUrl: 'http://trade.test',
      maxAgeMs: 30_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tickers = await port.sample(50);
    expect(tickers).toEqual([
      {
        marketId: 'btc-usdt',
        last: '42000.5',
        volume24h: '1000000',
        change24hBps: null,
        asOf: '2023-11-14T22:13:20.000Z',
        maxAgeMs: 30_000,
      },
    ]);
  });

  it('omits a ticker whose last is null, blank, or only whitespace', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          'ETH/USDT': {
            symbol: 'ETH/USDT',
            timestamp: 1_700_000_000_000,
            last: null,
            quoteVolume: '2',
            baseVolume: null,
            percentage: null,
          },
          'SOL/USDT': {
            symbol: 'SOL/USDT',
            timestamp: 1_700_000_000_000,
            last: '',
            quoteVolume: '3',
            baseVolume: null,
            percentage: null,
          },
          'XRP/USDT': {
            symbol: 'XRP/USDT',
            timestamp: 1_700_000_000_000,
            last: '   ',
            quoteVolume: '4',
            baseVolume: null,
            percentage: null,
          },
          'BTC/USDT': {
            symbol: 'BTC/USDT',
            timestamp: 1_700_000_000_000,
            last: '42000.5',
            quoteVolume: '1000000',
            baseVolume: null,
            percentage: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const port = createHttpSpotTickersPort({
      tradeUrl: 'http://trade.test',
      maxAgeMs: 30_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tickers = await port.sample(50);
    expect(tickers).toEqual([
      {
        marketId: 'btc-usdt',
        last: '42000.5',
        volume24h: '1000000',
        change24hBps: null,
        asOf: '2023-11-14T22:13:20.000Z',
        maxAgeMs: 30_000,
      },
    ]);
  });

  it('throws when trade is unreachable', async () => {
    const port = createHttpSpotTickersPort({
      tradeUrl: 'http://trade.test',
      fetchImpl: (async () => new Response('', { status: 502 })) as typeof fetch,
    });
    await expect(port.sample(50)).rejects.toThrow(/unreachable/);
  });

  it('omit limit refuses agents.tickers_limit_unset — never invent 500 or fetch', async () => {
    const fetchImpl = (async () => {
      throw new Error('must not fetch');
    }) as typeof fetch;
    const port = createHttpSpotTickersPort({
      tradeUrl: 'http://trade.test',
      fetchImpl,
    });
    await expect(port.sample()).rejects.toBeInstanceOf(AgentError);
    await expect(port.sample()).rejects.toMatchObject({ code: 'agents.tickers_limit_unset' });
  });

  it('owner-published 500 reaches the query string', async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://trade.test/api/v1/tickers?limit=500');
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const port = createHttpSpotTickersPort({
      tradeUrl: 'http://trade.test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(port.sample(500)).resolves.toEqual([]);
  });
});
