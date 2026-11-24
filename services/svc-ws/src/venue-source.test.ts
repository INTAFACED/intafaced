import { describe, expect, it, vi } from 'vitest';
import type { DepthSnapshot } from '@intafaced/market-data';
import { DepthSourceError, type DepthSource } from './depth/source.js';
import { MuxSourceError, type CandleSource, type MarketDirectory, type RawTicker, type TickerSource } from './mux/sources.js';
import {
  VenueMarketRegistry,
  VenueOrEngineCandleSource,
  VenueOrEngineDepthSource,
  VenueOrEngineMarketDirectory,
  VenueOrEngineTickerSource,
} from './venue-source.js';

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const doorOffFetch = () =>
  vi.fn(async () => jsonRes(404, { code: 'UserVenueOff', intafacedCode: 'trade.user_venue_off', message: 'door off' }));

const serverErrorFetch = () => vi.fn(async () => jsonRes(500, { code: 'Internal', message: 'boom' }));

describe('svc-ws venue-source (J-cex-spot-14 #8)', () => {
  it('VenueMarketRegistry lists venue symbols when door is on and returns empty when door is off', async () => {
    const fetchOn = vi.fn(async () => jsonRes(200, { value: { markets: [{ symbol: 'BTC-USDC' }, { symbol: 'ETH-USDC' }] } }));
    const regOn = new VenueMarketRegistry({ tradeUrl: 'http://trade', fetch: fetchOn });
    await expect(regOn.markets()).resolves.toEqual(['BTC-USDC', 'ETH-USDC']);

    const regOff = new VenueMarketRegistry({ tradeUrl: 'http://trade', fetch: doorOffFetch() });
    await expect(regOff.markets()).resolves.toEqual([]);
  });

  it('VenueOrEngineDepthSource reads venue book with sequence when on, falls back on door_off, surfaces 500', async () => {
    const engineSnap: DepthSnapshot = { type: 'snapshot', marketId: 'BTC-USDC', sequence: 1, bids: [['10', '1']], asks: [['11', '1']] };
    const engine: DepthSource = {
      markets: async () => ['BTC-USDC'],
      snapshot: vi.fn(async () => engineSnap),
    };
    const venueFetch = vi.fn(async () =>
      jsonRes(200, {
        value: { symbol: 'BTC-USDC', sequence: 42, bids: [{ price: '50000', amount: '2' }], asks: [{ price: '50010', amount: '1' }] },
      }),
    );
    const srcOn = new VenueOrEngineDepthSource(engine, { tradeUrl: 'http://trade', fetch: venueFetch });
    await expect(srcOn.snapshot('BTC-USDC', 20)).resolves.toEqual({
      type: 'snapshot',
      marketId: 'BTC-USDC',
      sequence: 42,
      bids: [['50000', '2']],
      asks: [['50010', '1']],
    });
    expect(engine.snapshot).not.toHaveBeenCalled();

    const srcOff = new VenueOrEngineDepthSource(engine, { tradeUrl: 'http://trade', fetch: doorOffFetch() });
    await expect(srcOff.snapshot('BTC-USDC', 20)).resolves.toEqual(engineSnap);
    expect(engine.snapshot).toHaveBeenCalledTimes(1);

    const srcErr = new VenueOrEngineDepthSource(engine, { tradeUrl: 'http://trade', fetch: serverErrorFetch() });
    await expect(srcErr.snapshot('BTC-USDC', 20)).rejects.toBeInstanceOf(DepthSourceError);
    expect(engine.snapshot).toHaveBeenCalledTimes(1);
  });

  it('VenueOrEngineMarketDirectory resolves slash and dash venue symbols when on and falls back on door_off', async () => {
    const engine: MarketDirectory = {
      refresh: vi.fn(async () => undefined),
      idForSymbol: vi.fn((s) => (s === 'BTC/USDT' ? 'eng-1' : null)),
      symbolFor: vi.fn((id) => (id === 'eng-1' ? 'BTC/USDT' : null)),
    };
    const fetchOn = vi.fn(async () => jsonRes(200, { value: { markets: [{ symbol: 'T14-USDC', baseAsset: 'T14', quoteAsset: 'USDC' }] } }));
    const dir = new VenueOrEngineMarketDirectory(engine, { tradeUrl: 'http://trade', fetch: fetchOn });
    await dir.refresh();
    expect(dir.idForSymbol('T14-USDC')).toBe('T14-USDC');
    expect(dir.idForSymbol('T14/USDC')).toBe('T14-USDC');
    expect(dir.symbolFor('T14-USDC')).toBe('T14-USDC');
    expect(engine.refresh).not.toHaveBeenCalled();

    const dirOff = new VenueOrEngineMarketDirectory(engine, { tradeUrl: 'http://trade', fetch: doorOffFetch() });
    await dirOff.refresh();
    expect(engine.refresh).toHaveBeenCalledTimes(1);
    expect(dirOff.idForSymbol('BTC/USDT')).toBe('eng-1');
  });

  it('VenueOrEngineTickerSource and VenueOrEngineCandleSource read venue when on, fall back on door_off, surface 500', async () => {
    const engTickers: readonly RawTicker[] = [
      {
        symbol: 'BTC/USDT',
        last: '100',
        bid: '99',
        ask: '101',
        spread: '2',
        volume: '10',
        quoteVolume: '1000',
        change24h: '0',
        changePct24h: '0',
        high24h: '101',
        low24h: '99',
      },
    ];
    const tickerEngine: TickerSource = { fetch: vi.fn(async () => engTickers) };
    const tickerFetch = vi.fn(async () =>
      jsonRes(200, {
        value: {
          'BTC-USDC': {
            symbol: 'BTC-USDC',
            last: '60000',
            bid: '59990',
            ask: '60010',
            spread: '20',
            volume: '5',
            quoteVolume: '300000',
            change24h: '0',
            changePct24h: '0',
            high24h: '60010',
            low24h: '59990',
          },
        },
      }),
    );
    const tsOn = new VenueOrEngineTickerSource(tickerEngine, { tradeUrl: 'http://trade', fetch: tickerFetch });
    const rows = await tsOn.fetch();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: 'BTC-USDC', bid: '59990', ask: '60010', spread: '20' });
    expect(tickerEngine.fetch).not.toHaveBeenCalled();

    const tsOff = new VenueOrEngineTickerSource(tickerEngine, { tradeUrl: 'http://trade', fetch: doorOffFetch() });
    await expect(tsOff.fetch()).resolves.toEqual(engTickers);

    const tsErr = new VenueOrEngineTickerSource(tickerEngine, { tradeUrl: 'http://trade', fetch: serverErrorFetch() });
    await expect(tsErr.fetch()).rejects.toBeInstanceOf(MuxSourceError);

    const engCandles = [{ t: 60_000, o: '1', h: '2', l: '1', c: '2', v: '5' }];
    const candleEngine: CandleSource = { latest: vi.fn(async () => engCandles) };
    const candleFetch = vi.fn(async () =>
      jsonRes(200, {
        value: [{ openAt: '2026-11-24T10:00:00.000Z', openPrice: '10', highPrice: '12', lowPrice: '9', closePrice: '11', baseVolume: '7' }],
      }),
    );
    const csOn = new VenueOrEngineCandleSource(candleEngine, { tradeUrl: 'http://trade', fetch: candleFetch });
    await expect(csOn.latest('BTC-USDC', '1m', 0, 5)).resolves.toEqual([
      { t: Date.parse('2026-11-24T10:00:00.000Z'), o: '10', h: '12', l: '9', c: '11', v: '7' },
    ]);
    expect(candleEngine.latest).not.toHaveBeenCalled();

    const csOff = new VenueOrEngineCandleSource(candleEngine, { tradeUrl: 'http://trade', fetch: doorOffFetch() });
    await expect(csOff.latest('BTC-USDC', '1m', 0, 5)).resolves.toEqual(engCandles);

    const csErr = new VenueOrEngineCandleSource(candleEngine, { tradeUrl: 'http://trade', fetch: serverErrorFetch() });
    await expect(csErr.latest('BTC-USDC', '1m', 0, 5)).rejects.toBeInstanceOf(MuxSourceError);
  });
});
