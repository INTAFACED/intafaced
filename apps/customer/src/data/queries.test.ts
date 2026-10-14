import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';
import type { ApiClient } from '../shared/api';
import { HOUR_MS } from './derive';
import { fmtPct, fmtUsd } from './format';
import { createPoller, type Poller, type VisibilitySource } from './poll';
import {
  candlesSource,
  moversSource,
  portfolioSource,
  sparklinesSource,
  tickerSource,
  tickersSource,
  marketsSource,
  type DataEnv,
} from './queries';
import type { Source } from './source';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as unknown;
const MARKETS = fixture('markets.json') as Array<Record<string, unknown> & { symbol: string }>;
const TICKERS = fixture('tickers.json') as Record<string, Record<string, unknown>>;

// 2026-10-13 12:30:00 UTC, the middle of an hour.
const NOW = Date.UTC(2026, 9, 13, 12, 30, 0);
const hour = (hoursAgo: number) => Math.floor(NOW / HOUR_MS) * HOUR_MS - hoursAgo * HOUR_MS;

const alwaysVisible: VisibilitySource = { isVisible: () => true, subscribe: () => () => undefined };

type Handler = (query: Record<string, unknown>, path: string) => unknown;
type Failure = { fail: { reason: string; status: number; code?: string } };

function fakeApi(handlers: Record<string, Handler>) {
  const calls: Array<{ path: string; query: Record<string, unknown> }> = [];
  const rest = vi.fn(async (path: string, schema: ZodType, options: { query?: Record<string, unknown> } = {}) => {
    const query = options.query ?? {};
    calls.push({ path, query });
    const key = Object.keys(handlers).find((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    if (!key) return { ok: false, reason: 'not_mounted', status: 404, message: 'no route' };
    const result = handlers[key]!(query, path);
    if (result && typeof result === 'object' && 'fail' in result) return { ok: false, message: 'x', ...(result as Failure).fail };
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new Error(`fixture does not match the client schema for ${path}: ${parsed.error.message}`);
    return { ok: true, data: parsed.data };
  });
  const countOf = (prefix: string) => calls.filter((c) => c.path === prefix || c.path.startsWith(`${prefix}/`)).length;
  return { api: { rest } as unknown as ApiClient, calls, countOf };
}

/** Hourly candles for a symbol: the candle h hours ago has open/close base + h (IFC: 1.00hh), so the 24 h open is easy to know. */
function hourly(base: number) {
  const price = (h: number) => (base === 1 ? String((10000 + h) / 10000) : String(base + h));
  return (query: Record<string, unknown>) => {
    expect(query).toMatchObject({ timeframe: '1h', limit: 25 });
    const rows: unknown[] = [];
    for (let h = 24; h >= 0; h -= 1)
      rows.push([hour(h), price(h), base === 1 ? '2' : String(base + h + 5), base === 1 ? '0.5' : String(base + h - 5), price(h), '0.5']);
    return rows;
  };
}

const LIVE = ['BTC/USDT', 'BTC/USDC', 'ETH/USDT', 'ETH/USDC', 'IFC/USDT'];
const bases: Record<string, number> = { 'BTC/USDT': 65000, 'BTC/USDC': 65100, 'ETH/USDT': 2500, 'ETH/USDC': 2510, 'IFC/USDT': 1 };

function standardRoutes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    '/markets': () => MARKETS,
    '/tickers': () => TICKERS,
    '/ohlcv': (query, path) => hourly(bases[decodeURIComponent(path.split('/ohlcv/')[1]!)] ?? 1)(query),
    ...extra,
  };
}

let pollers: Poller[] = [];
function envFor(api: ApiClient, userId: string | null = 'user-1'): DataEnv {
  const poller = createPoller({ visibility: alwaysVisible });
  pollers.push(poller);
  return { poller, api, userId };
}

/** Subscribe, let the requests settle, return the snapshot and the stop function. */
async function read<T>(source: Source<T>, ms = 200) {
  const stop = source.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(ms);
  return { snap: source.getSnapshot(), stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  pollers.forEach((p) => p.dispose());
  pollers = [];
  vi.useRealTimers();
});

describe('markets', () => {
  it('lists only markets that are orderable AND open, spot, and carries tick/lot sizes', async () => {
    const { api, calls } = fakeApi(standardRoutes());
    const { snap, stop } = await read(marketsSource(envFor(api)));
    expect(snap.status).toBe('ready');
    if (snap.status !== 'ready') return;
    expect(snap.data.map((m) => m.symbol).sort()).toEqual([...LIVE].sort());
    const btc = snap.data.find((m) => m.symbol === 'BTC/USDT')!;
    expect(btc).toMatchObject({
      base: 'BTC',
      quote: 'USDT',
      orderable: true,
      tickSize: '0.01',
      lotSize: '0.00001',
      minAmount: '0.00001',
      listedAt: null,
    });
    expect(calls[0]).toEqual({ path: '/markets', query: { limit: 500 } }); // limit is mandatory
    stop();
  });

  it('includeClosed shows the rest, marked not orderable (WTI says orderable but its market is not OPEN)', async () => {
    const { api } = fakeApi(standardRoutes());
    const { snap, stop } = await read(marketsSource(envFor(api), { includeClosed: true }));
    if (snap.status !== 'ready') throw new Error('not ready');
    expect(snap.data.length).toBe(7);
    expect(snap.data.find((m) => m.symbol === 'WTI/USD')!.orderable).toBe(false);
    expect(snap.data.find((m) => m.symbol === 'EUR/USD')!.orderable).toBe(false);
    stop();
  });

  it('turns a typed refusal into a refused state, and 5xx into an error', async () => {
    const refused = fakeApi(
      standardRoutes({ '/markets': () => ({ fail: { reason: 'forbidden', status: 403, code: 'denied.screening_fixture' } }) }),
    );
    const a = await read(marketsSource(envFor(refused.api)));
    expect(a.snap).toEqual({ status: 'refused', code: 'denied.screening_fixture' });
    a.stop();
    const down = fakeApi(standardRoutes({ '/markets': () => ({ fail: { reason: 'unreachable', status: 502 } }) }));
    const b = await read(marketsSource(envFor(down.api)));
    expect(b.snap.status).toBe('error');
    b.stop();
  });
});

describe('tickers with derived 24 h stats', () => {
  it('derives open/high/low/volume/change for each live market from 25 hourly candles', async () => {
    const { api, calls, countOf } = fakeApi(standardRoutes());
    const { snap, stop } = await read(tickersSource(envFor(api)));
    expect(snap.status).toBe('ready');
    if (snap.status !== 'ready') return;
    expect(Object.keys(snap.data).sort()).toEqual([...LIVE].sort());
    const btc = snap.data['BTC/USDT']!;
    // Candle at hour(23) is the first one at or after now-24h: open 65023. High is 65023+5 .. 65000+0+5 across the window.
    expect(btc.open24h).toBe('65023');
    expect(btc.high24h).toBe('65028');
    expect(btc.low24h).toBe('64995');
    expect(btc.baseVolume24h).toBe('12'); // 24 candles x 0.5
    expect(btc.quoteVolume24h).toBeNull(); // candles carry none
    expect(btc.last).toBe('65044.96'); // from the ticker, not the candle
    expect(btc.change24h).toBe('21.96');
    expect(fmtPct(btc.changePct24h)).toBe('+0.03%');
    expect(btc.source).toBe('derived');
    expect(snap.data['IFC/USDT']!.last).toBe('1.0036');
    // Requests: one markets, one tickers, one hourly series per live market, symbols URL-encoded, limits sent.
    expect(countOf('/markets')).toBe(1);
    expect(countOf('/tickers')).toBe(1);
    expect(countOf('/ohlcv')).toBe(5);
    expect(calls.filter((c) => c.path.startsWith('/ohlcv')).every((c) => /%2F/.test(c.path) && c.query.limit === 25)).toBe(true);
    expect(calls.find((c) => c.path === '/tickers')!.query).toEqual({ limit: 500 });
    stop();
  });

  it('stays loading until the derivation calls answer (no flash from "—" to a number)', async () => {
    const { api } = fakeApi(standardRoutes());
    const env = envFor(api);
    const source = tickersSource(env);
    const stop = source.subscribe(() => undefined);
    expect(source.getSnapshot().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(200);
    expect(source.getSnapshot().status).toBe('ready');
    stop();
  });

  it('prefers server fields when the service sends them (U1) and then makes no candle calls', async () => {
    const withStats = Object.fromEntries(
      Object.entries(TICKERS).map(([symbol, t]) => [
        symbol,
        {
          ...t,
          open: '64000',
          high: '66000',
          low: '63000',
          baseVolume: '10',
          quoteVolume: '650000',
          change: '1044.96',
          percentage: '1.6327',
          sparkline: ['1', '2', '3'],
        },
      ]),
    );
    const { api, countOf } = fakeApi(standardRoutes({ '/tickers': () => withStats }));
    const { snap, stop } = await read(tickersSource(envFor(api)));
    if (snap.status !== 'ready') throw new Error('not ready');
    const btc = snap.data['BTC/USDT']!;
    expect(btc).toMatchObject({
      open24h: '64000',
      high24h: '66000',
      low24h: '63000',
      baseVolume24h: '10',
      quoteVolume24h: '650000',
      change24h: '1044.96',
      source: 'server',
    });
    expect(countOf('/ohlcv')).toBe(0);
    stop();
  });

  it('skips derivation above 20 orderable markets: the 24 h columns stay unknown', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      ...MARKETS.find((m) => m.symbol === 'BTC/USDT')!,
      symbol: `C${i}/USDT`,
      base: `C${i}`,
    }));
    const tickers = Object.fromEntries(many.map((m) => [m.symbol, { ...TICKERS['BTC/USDT']!, symbol: m.symbol }]));
    const { api, countOf } = fakeApi(standardRoutes({ '/markets': () => many, '/tickers': () => tickers }));
    const { snap, stop } = await read(tickersSource(envFor(api)));
    if (snap.status !== 'ready') throw new Error('not ready');
    expect(Object.keys(snap.data).length).toBe(21);
    expect(snap.data['C0/USDT']).toMatchObject({ open24h: null, changePct24h: null, change24h: null });
    expect(snap.data['C0/USDT']!.last).toBe('65044.96');
    expect(countOf('/ohlcv')).toBe(0);
    stop();
  });

  it('a candle series that fails leaves only that market without 24 h numbers', async () => {
    const { api } = fakeApi(
      standardRoutes({
        '/ohlcv': (query, path) =>
          path.includes('IFC')
            ? { fail: { reason: 'unreachable', status: 502 } }
            : hourly(bases[decodeURIComponent(path.split('/ohlcv/')[1]!)] ?? 1)(query),
      }),
    );
    const { snap, stop } = await read(tickersSource(envFor(api)));
    if (snap.status !== 'ready') throw new Error('not ready');
    expect(snap.data['IFC/USDT']).toMatchObject({ last: '1.0036', open24h: null, changePct24h: null });
    expect(snap.data['BTC/USDT']!.open24h).toBe('65023');
    stop();
  });

  it('one market: useTicker polls /ticker/{symbol} and derives its own stats', async () => {
    const { api, calls } = fakeApi({ ...standardRoutes(), '/ticker': () => TICKERS['ETH/USDT'] });
    const { snap, stop } = await read(tickerSource(envFor(api), 'ETH/USDT'));
    if (snap.status !== 'ready') throw new Error('not ready');
    expect(snap.data).toMatchObject({ symbol: 'ETH/USDT', last: '2614.93', open24h: '2523', source: 'derived' });
    expect(calls.map((c) => c.path)).toContain('/ticker/ETH%2FUSDT');
    stop();
  });

  it('one market: a refusal such as "no book" reaches the screen as a typed code', async () => {
    const { api } = fakeApi({ '/ticker': () => ({ fail: { reason: 'not_mounted', status: 404, code: 'trade.no_book' } }) });
    const { snap, stop } = await read(tickerSource(envFor(api), 'XYZ/USDT'));
    expect(snap).toEqual({ status: 'refused', code: 'trade.no_book' });
    stop();
  });
});

describe('movers and sparklines', () => {
  it('ranks derived moves, one row per coin', async () => {
    const { api } = fakeApi(standardRoutes());
    const { snap, stop } = await read(moversSource(envFor(api), 6));
    if (snap.status !== 'ready') throw new Error(`not ready: ${snap.status}`);
    // Every live market is up against its candle open (last > open24h), so no losers.
    expect(snap.data.losers).toEqual([]);
    const coins = snap.data.gainers.map((r) => r.symbol.split('/')[0]);
    expect(new Set(coins).size).toBe(coins.length);
    expect(snap.data.gainers.length).toBe(3); // BTC, ETH, IFC
    stop();
  });

  it('sparklines are the closes of the same 25 candles, 24 points, shared with the ticker derivation', async () => {
    const { api, countOf } = fakeApi(standardRoutes());
    const env = envFor(api);
    const tickers = tickersSource(env);
    const sparks = sparklinesSource(env, ['BTC/USDT', 'ETH/USDT']);
    const a = tickers.subscribe(() => undefined);
    const b = sparks.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(300);
    const snap = sparks.getSnapshot();
    if (snap.status !== 'ready') throw new Error('not ready');
    expect(snap.data['BTC/USDT']!.length).toBe(24);
    expect(snap.data['BTC/USDT']![23]).toBe('65000');
    expect(countOf('/ohlcv')).toBe(5); // deduped: the same series feed both
    a();
    b();
  });

  it('uses a dense server sparkline (12 points or more) and asks for no candles', async () => {
    const dense = Array.from({ length: 12 }, (_, i) => String(i + 1));
    const withSpark = Object.fromEntries(Object.entries(TICKERS).map(([s, t]) => [s, { ...t, sparkline: dense }]));
    const { api, countOf } = fakeApi(standardRoutes({ '/tickers': () => withSpark }));
    const env = envFor(api);
    const sparks = sparklinesSource(env, ['BTC/USDT']);
    const { snap, stop } = await read(sparks);
    if (snap.status !== 'ready') throw new Error('not ready');
    expect(snap.data['BTC/USDT']).toEqual(dense);
    expect(countOf('/ohlcv')).toBe(0);
    stop();
  });

  it('replaces a crude 5-point server sparkline with 15 minute closes, one request per symbol (critic M2)', async () => {
    const crude = Object.fromEntries(Object.entries(TICKERS).map(([s, t]) => [s, { ...t, sparkline: ['1', '2', '3', '4', '5'] }]));
    const quarter = Math.floor(NOW / 900_000) * 900_000;
    const { api, calls, countOf } = fakeApi(
      standardRoutes({
        '/tickers': () => crude,
        '/ohlcv': (query) => {
          expect(query).toMatchObject({ timeframe: '15m', limit: 96 });
          return Array.from({ length: 96 }, (_, i) => {
            const price = String(65000 + i);
            return [quarter - (95 - i) * 900_000, price, price, price, price, '0.5'];
          });
        },
      }),
    );
    const env = envFor(api);
    const { snap, stop } = await read(sparklinesSource(env, ['BTC/USDT']));
    if (snap.status !== 'ready') throw new Error('not ready');
    expect(snap.data['BTC/USDT']!.length).toBe(96);
    expect(snap.data['BTC/USDT']![95]).toBe('65095');
    expect(countOf('/ohlcv')).toBe(1);
    expect(calls.filter((c) => c.path.startsWith('/ohlcv/')).every((c) => c.query.timeframe === '15m')).toBe(true);
    stop();
  });

  it('no symbols means empty, with no requests', async () => {
    const { api, calls } = fakeApi(standardRoutes());
    const { snap } = await read(sparklinesSource(envFor(api), []));
    expect(snap.status).toBe('empty');
    expect(calls.length).toBe(0);
  });
});

describe('candles', () => {
  it('forward-fills silent minutes up to the current one', async () => {
    const minute = Math.floor(NOW / 60_000) * 60_000;
    const { api } = fakeApi({
      '/ohlcv': (query) => {
        expect(query).toEqual({ timeframe: '1m', limit: 5 });
        return [
          [minute - 240_000, '100', '101', '99', '100.5', '1'],
          [minute - 60_000, '100.5', '102', '100', '101', '2'],
        ];
      },
    });
    const { snap, stop } = await read(candlesSource(envFor(api), 'BTC/USDT', '1m', 5));
    if (snap.status !== 'ready') throw new Error('not ready');
    expect(snap.data.map((c) => [c.t, c.c, c.filled])).toEqual([
      [minute - 240_000, '100.5', false],
      [minute - 180_000, '100.5', true],
      [minute - 120_000, '100.5', true],
      [minute - 60_000, '101', false],
      [minute, '101', true],
    ]);
    stop();
  });

  it('no candles at all is the empty state, not a flat line', async () => {
    const { api } = fakeApi({ '/ohlcv': () => [] });
    const { snap, stop } = await read(candlesSource(envFor(api), 'BTC/USDT', '1h', 24));
    expect(snap.status).toBe('empty');
    stop();
  });
});

describe('portfolio', () => {
  const BALANCES = {
    BTC: { free: '0.5', used: '0', total: '0.5' },
    ETH: { free: '2', used: '0', total: '2' },
    IFC: { free: '10', used: '0', total: '10' },
    USDC: { free: '50.5', used: '0', total: '50.5' },
    USDT: { free: '100.25', used: '0', total: '100.25' },
  };
  const balanceRoute =
    (balances: Record<string, unknown>): Handler =>
    () => ({ timestamp: NOW, datetime: new Date(NOW).toISOString(), balances });

  it('equals the hand-computed sum to the cent, from the same /account/balance and /tickers responses', async () => {
    // BTC 0.5  x 65044.96 = 32522.48
    // ETH 2    x 2614.93  =  5229.86
    // IFC 10   x 1.0036   =    10.036
    // USDC 50.5 + USDT 100.25 = 150.75
    // total = 37913.126 -> $37,913.13
    const { api } = fakeApi(standardRoutes({ '/account/balance': balanceRoute(BALANCES) }));
    const { snap, stop } = await read(portfolioSource(envFor(api)), 400);
    if (snap.status !== 'ready') throw new Error(`not ready: ${snap.status}`);
    expect(snap.data.totalUsd).toBe('37913.126');
    expect(fmtUsd(snap.data.totalUsd)).toBe('$37,913.13');
    expect(snap.data.cashUsd).toBe('150.75');
    expect(snap.data.cryptoUsd).toBe('37762.376');
    expect(snap.data.source).toBe('derived');
    expect(snap.data.holdings.map((h) => h.asset)).toEqual(['BTC', 'ETH', 'USDT', 'USDC', 'IFC']);
    // Today, from the candle opens (65023, 2523, 1.0023):
    // BTC 0.5 x 21.96 = 10.98; ETH 2 x 91.93 = 183.86; IFC 10 x 0.0013 = 0.013; total 194.853
    expect(snap.data.change24hUsd).toBe('194.853');
    stop();
  });

  it('a wallet of only USDT and USDC needs no market data at all', async () => {
    const { api, calls } = fakeApi(
      standardRoutes({
        '/account/balance': balanceRoute({ USDT: { free: '1', used: '0', total: '1' }, USDC: { free: '2.5', used: '0', total: '2.5' } }),
      }),
    );
    const { snap, stop } = await read(portfolioSource(envFor(api)));
    if (snap.status !== 'ready') throw new Error('not ready');
    expect(snap.data.totalUsd).toBe('3.5');
    expect(calls.map((c) => c.path)).toEqual(['/account/balance']);
    stop();
  });

  it('an empty wallet is zero (the balance call really returned nothing)', async () => {
    const { api } = fakeApi(standardRoutes({ '/account/balance': balanceRoute({}) }));
    const { snap, stop } = await read(portfolioSource(envFor(api)));
    if (snap.status !== 'ready') throw new Error('not ready');
    expect(snap.data.totalUsd).toBe('0');
    stop();
  });

  it('never shows a partial total: if prices cannot load, the whole summary errors', async () => {
    const { api } = fakeApi(
      standardRoutes({ '/account/balance': balanceRoute(BALANCES), '/tickers': () => ({ fail: { reason: 'unreachable', status: 502 } }) }),
    );
    const { snap, stop } = await read(portfolioSource(envFor(api)), 400);
    expect(snap.status).toBe('error');
    stop();
  });

  it('a refused balance call is a refusal with its code', async () => {
    const { api } = fakeApi(
      standardRoutes({ '/account/balance': () => ({ fail: { reason: 'forbidden', status: 403, code: 'denied.kyc_required' } }) }),
    );
    const { snap, stop } = await read(portfolioSource(envFor(api)));
    expect(snap).toEqual({ status: 'refused', code: 'denied.kyc_required' });
    stop();
  });

  it('signed out is a refusal, not a request', async () => {
    const { api, calls } = fakeApi(standardRoutes());
    const { snap } = await read(portfolioSource(envFor(api, null)));
    expect(snap).toEqual({ status: 'refused', code: 'auth.required' });
    expect(calls.length).toBe(0);
  });

  it("one user's balance is never served to another (cache is keyed by user)", async () => {
    const a = fakeApi(standardRoutes({ '/account/balance': balanceRoute({ USDT: { free: '1', used: '0', total: '1' } }) }));
    const b = fakeApi(standardRoutes({ '/account/balance': balanceRoute({ USDT: { free: '2', used: '0', total: '2' } }) }));
    const poller = createPoller({ visibility: alwaysVisible });
    pollers.push(poller);
    const one = await read(portfolioSource({ poller, api: a.api, userId: 'user-1' }));
    const two = await read(portfolioSource({ poller, api: b.api, userId: 'user-2' }));
    if (one.snap.status !== 'ready' || two.snap.status !== 'ready') throw new Error('not ready');
    expect(one.snap.data.totalUsd).toBe('1');
    expect(two.snap.data.totalUsd).toBe('2');
    one.stop();
    two.stop();
  });
});

describe('request budget on the Home screen', () => {
  it('Home (portfolio + markets + tickers + 4 sparklines + movers) stays well under 120 per minute', async () => {
    const { api } = fakeApi(
      standardRoutes({
        '/account/balance': () => ({
          timestamp: NOW,
          datetime: new Date(NOW).toISOString(),
          balances: { BTC: { free: '1', used: '0', total: '1' }, USDT: { free: '5', used: '0', total: '5' } },
        }),
      }),
    );
    const env = envFor(api);
    const stops = [
      portfolioSource(env),
      marketsSource(env),
      tickersSource(env),
      sparklinesSource(env, ['BTC/USDT', 'ETH/USDT', 'IFC/USDT', 'BTC/USDC']),
      moversSource(env, 6),
    ].map((s) => s.subscribe(() => undefined));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const stats = env.poller.stats();
    expect(stats.totalRequests / 5).toBeLessThanOrEqual(30); // spec: Home <= 30 per minute
    expect(stats.peakPerMinute).toBeLessThanOrEqual(120);
    expect(stats.deferred).toBe(0);
    stops.forEach((s) => s());
  });
});
