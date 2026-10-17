import { describe, expect, it, vi } from 'vitest';
import { HttpCandleSource, HttpMarketDirectory, HttpTickerSource, MuxSourceError, parseCandleRow, parseTicker } from './sources.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('parseTicker — svc-trade ticker row → wire row', () => {
  it('maps the 24 h facts and keeps every amount a decimal string', () => {
    expect(
      parseTicker('BTC/USDT', {
        symbol: 'BTC/USDT',
        last: '30000.5',
        change: '120.25',
        percentage: '0.4',
        high: '31000',
        low: '29000',
        baseVolume: '12.5',
        quoteVolume: '375000',
        bid: '30000',
      }),
    ).toEqual({
      symbol: 'BTC/USDT',
      last: '30000.5',
      change24h: '120.25',
      changePct24h: '0.4',
      high: '31000',
      low: '29000',
      volume: '12.5',
      quoteVolume: '375000',
    });
  });

  it('keeps null as null: a market that never traded has no 24 h high, not a zero one', () => {
    const row = parseTicker('NEW/USDT', {
      last: null,
      high: null,
      low: null,
      baseVolume: null,
      quoteVolume: null,
      change: null,
      percentage: null,
    });
    expect(row).toMatchObject({ symbol: 'NEW/USDT', last: null, high: null, volume: null, changePct24h: null });
  });

  it('refuses a row where an amount is a JSON number — it has already been through a float', () => {
    expect(parseTicker('X/USDT', { last: 30000.5, high: '1' })).toBeNull();
    expect(parseTicker('X/USDT', { last: '1', baseVolume: 12 })).toBeNull();
    expect(parseTicker('X/USDT', { last: '1e9' })).toBeNull();
    expect(parseTicker('X/USDT', 'nope')).toBeNull();
  });
});

describe('HttpTickerSource', () => {
  it('reads the owner-published page of tickers with no credential', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ 'BTC/USDT': { last: '1', high: '2' }, 'ETH/USDT': { last: '3' } }),
    );
    const source = new HttpTickerSource({ baseUrl: 'http://trade.test/', marketsLimit: 50, fetch: fetchMock as never });
    const rows = await source.fetch();
    expect(rows.map((r) => r.symbol).sort()).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://trade.test/api/v1/tickers?limit=50');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization|secret|signature/i);
  });

  it('serves the good rows when one row is refused', async () => {
    const warn = vi.fn();
    const source = new HttpTickerSource({
      baseUrl: 'http://trade.test',
      marketsLimit: 50,
      log: { info: vi.fn(), warn },
      fetch: (async () => json({ 'BAD/USDT': { last: 1.5 }, 'OK/USDT': { last: '1.5' } })) as never,
    });
    expect((await source.fetch()).map((r) => r.symbol)).toEqual(['OK/USDT']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('refuses to invent a listing page when the limit is unpublished', async () => {
    const source = new HttpTickerSource({ baseUrl: 'http://trade.test', marketsLimit: undefined, fetch: (async () => json({})) as never });
    await expect(source.fetch()).rejects.toMatchObject({ code: 'ws.markets_list_limit_unset' });
  });

  it('turns a non-2xx or an unreachable upstream into a MuxSourceError', async () => {
    const down = new HttpTickerSource({ baseUrl: 'http://trade.test', marketsLimit: 5, fetch: (async () => json({}, 502)) as never });
    await expect(down.fetch()).rejects.toBeInstanceOf(MuxSourceError);
    const dead = new HttpTickerSource({
      baseUrl: 'http://trade.test',
      marketsLimit: 5,
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as never,
    });
    await expect(dead.fetch()).rejects.toBeInstanceOf(MuxSourceError);
  });
});

describe('candle rows — CCXT [t, o, h, l, c, v] → wire candle', () => {
  it('parses an OHLCV row with decimal-string prices', () => {
    expect(parseCandleRow([1_700_000_040_000, '100', '110', '99', '108', '4.25'])).toEqual({
      t: 1_700_000_040_000,
      o: '100',
      h: '110',
      l: '99',
      c: '108',
      v: '4.25',
    });
  });

  it('refuses a number where a price belongs, a short row, and a bad timestamp', () => {
    expect(parseCandleRow([1, 100, '110', '99', '108', '4'])).toBeNull();
    expect(parseCandleRow([1, '100', '110', '99', '108'])).toBeNull();
    expect(parseCandleRow(['1', '100', '110', '99', '108', '4'])).toBeNull();
    expect(parseCandleRow([-1, '100', '110', '99', '108', '4'])).toBeNull();
    expect(parseCandleRow([1.5, '100', '110', '99', '108', '4'])).toBeNull();
    expect(parseCandleRow({})).toBeNull();
  });
});

describe('HttpCandleSource', () => {
  it('asks for the timeframe, a bounded since and a bounded limit — never the whole history', async () => {
    const fetchMock = vi.fn(async (_url: string) => json([[60_000, '1', '2', '1', '2', '3']]));
    const source = new HttpCandleSource({ baseUrl: 'http://trade.test', fetch: fetchMock as never });
    const rows = await source.latest('BTC/USDT', '5m', 123_456, 2);
    expect(rows).toEqual([{ t: 60_000, o: '1', h: '2', l: '1', c: '2', v: '3' }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://trade.test/api/v1/ohlcv/BTC%2FUSDT?timeframe=5m&since=123456&limit=2');
  });

  it('drops a malformed row and keeps the rest', async () => {
    const source = new HttpCandleSource({
      baseUrl: 'http://trade.test',
      fetch: (async () =>
        json([
          [1, 5, '1', '1', '1', '1'],
          [2, '1', '1', '1', '1', '1'],
        ])) as never,
    });
    expect(await source.latest('X/Y', '1m', 0, 2)).toEqual([{ t: 2, o: '1', h: '1', l: '1', c: '1', v: '1' }]);
  });

  it('throws when the answer is not a list', async () => {
    const source = new HttpCandleSource({ baseUrl: 'http://trade.test', fetch: (async () => json({ nope: 1 })) as never });
    await expect(source.latest('X/Y', '1m', 0, 2)).rejects.toBeInstanceOf(MuxSourceError);
  });
});

describe('HttpMarketDirectory', () => {
  it('maps id ↔ symbol from the listing and caches it for the window', async () => {
    let now = 0;
    const fetchMock = vi.fn(async (_url: string) =>
      json([{ id: 'id-1', symbol: 'BTC/USDT' }, { id: 'id-2', symbol: 'ETH/USDT' }, { id: 'id-3' }]),
    );
    const dir = new HttpMarketDirectory({
      baseUrl: 'http://trade.test',
      marketsLimit: 50,
      ttlMs: 30_000,
      clock: () => now,
      fetch: fetchMock as never,
    });
    await dir.refresh();
    expect(dir.idForSymbol('BTC/USDT')).toBe('id-1');
    expect(dir.symbolFor('id-2')).toBe('ETH/USDT');
    expect(dir.idForSymbol('NOPE/USDT')).toBeNull();
    await dir.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now = 31_000;
    await dir.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known directory when a refresh fails, and never throws', async () => {
    let fail = false;
    let now = 0;
    const dir = new HttpMarketDirectory({
      baseUrl: 'http://trade.test',
      marketsLimit: 50,
      ttlMs: 1_000,
      clock: () => now,
      fetch: (async () => (fail ? json({}, 503) : json([{ id: 'id-1', symbol: 'BTC/USDT' }]))) as never,
    });
    await dir.refresh();
    fail = true;
    now = 5_000;
    await expect(dir.refresh()).resolves.toBeUndefined();
    expect(dir.idForSymbol('BTC/USDT')).toBe('id-1');
  });
});
