import { describe, expect, it } from 'vitest';
import { capturePass, coverageOf, createMemoryLakeStore, type LakePass } from './lake.js';

// RC-algo-dev-02 (J-algo-dev-16 #2): capture from the exchange's public routes, coverage and gaps from the passes.
const pass = (at: string, ok = true): LakePass => ({ symbol: 'BTC/USDT', kind: 'tick', at, ok, reason: ok ? null : 'down' });

describe('coverageOf', () => {
  it('an hour without a pass is one hole between two ranges', () => {
    const passes = [
      pass('2026-11-15T00:00:00.000Z'),
      pass('2026-11-15T00:00:05.000Z'),
      pass('2026-11-15T01:00:05.000Z'),
      pass('2026-11-15T01:00:10.000Z'),
    ];
    expect(coverageOf(passes, 5)).toEqual({
      ranges: [
        { from: '2026-11-15T00:00:00.000Z', to: '2026-11-15T00:00:05.000Z' },
        { from: '2026-11-15T01:00:05.000Z', to: '2026-11-15T01:00:10.000Z' },
      ],
      holes: [{ from: '2026-11-15T00:00:05.000Z', to: '2026-11-15T01:00:05.000Z' }],
    });
  });
  it('a failed pass covers nothing', () => {
    expect(coverageOf([pass('2026-11-15T00:00:00.000Z', false)], 5)).toEqual({ ranges: [], holes: [] });
  });
});

describe('capturePass', () => {
  const routes: Record<string, unknown> = {
    '/api/v1/ticker/BTC%2FUSDT': { symbol: 'BTC/USDT', bid: '99', ask: '101', last: '100' },
    '/api/v1/orderbook/BTC%2FUSDT?limit=10': { bids: [['99', '1']], asks: [['101', '2']], nonce: 7 },
  };
  const fetch = async (url: string) => {
    const path = url.replace('http://trade', '');
    if (path.startsWith('/api/v1/trades/BTC%2FUSDT')) {
      return {
        status: 200,
        json: async () => [{ id: 't1', timestamp: Date.parse('2026-11-14T23:59:59.000Z'), side: 'buy', price: '100', amount: '0.5' }],
      };
    }
    return path in routes ? { status: 200, json: async () => routes[path] } : { status: 502, json: async () => ({}) };
  };
  const settings = { symbols: ['BTC/USDT', 'ETH/USDT'], captureSeconds: 5, retentionDays: 7 };

  it('stores normalised rows and a pass per kind; a failed read is a hole, never a row', async () => {
    const store = createMemoryLakeStore();
    const at = Date.parse('2026-11-15T00:00:00.000Z');
    const out = await capturePass({ tradeUrl: 'http://trade', settings, store, now: () => at, fetch });
    expect(out).toEqual({ rows: 3, holes: 3 });
    expect((await store.latest('BTC/USDT', 'book', 1))[0]!.payload).toMatchObject({
      occupancy: 'populated',
      bids: [['99', '1']],
      sequence: 7,
    });
    expect((await store.latest('BTC/USDT', 'fill', 1))[0]!.payload).toMatchObject({ price: '100', quantity: '0.5', side: 'buy' });
    expect(await store.extent('ETH/USDT', 'tick')).toEqual({ count: 0, first: null, last: null });
    expect((await store.passes('ETH/USDT', 'tick', '2026-01-01T00:00:00.000Z'))[0]).toMatchObject({ ok: false });
    // The same print again is one row.
    await capturePass({ tradeUrl: 'http://trade', settings, store, now: () => at + 5_000, fetch });
    expect((await store.extent('BTC/USDT', 'fill')).count).toBe(1);
  });

  it('a paused symbol is not captured, so its time reads as a gap', async () => {
    const store = createMemoryLakeStore();
    let at = Date.parse('2026-11-15T00:00:00.000Z');
    const once = () =>
      capturePass({ tradeUrl: 'http://trade', settings: { ...settings, symbols: ['BTC/USDT'] }, store, now: () => at, fetch });
    await once();
    at += 5_000;
    await once();
    await store.change({ symbol: 'BTC/USDT', capturing: false, reason: 'TEST', actor: 'op', key: 'k1', at: new Date(at).toISOString() });
    for (let i = 0; i < 4; i += 1) {
      at += 5_000;
      await once();
    }
    await store.change({ symbol: 'BTC/USDT', capturing: true, reason: 'TEST', actor: 'op', key: 'k2', at: new Date(at).toISOString() });
    at += 5_000;
    await once();
    const cov = coverageOf(await store.passes('BTC/USDT', 'tick', '2026-01-01T00:00:00.000Z'), 5);
    expect(cov.ranges).toHaveLength(2);
    expect(cov.holes).toEqual([{ from: '2026-11-15T00:00:05.000Z', to: '2026-11-15T00:00:30.000Z' }]);
  });

  it('rows older than the retention leave; rows inside stay', async () => {
    const store = createMemoryLakeStore();
    const day = 86_400_000;
    const start = Date.parse('2026-11-01T00:00:00.000Z');
    await capturePass({ tradeUrl: 'http://trade', settings: { ...settings, symbols: ['BTC/USDT'] }, store, now: () => start, fetch });
    await capturePass({
      tradeUrl: 'http://trade',
      settings: { ...settings, symbols: ['BTC/USDT'] },
      store,
      now: () => start + 8 * day,
      fetch,
    });
    expect((await store.extent('BTC/USDT', 'tick')).count).toBe(1);
    expect((await store.extent('BTC/USDT', 'tick')).first).toBe(new Date(start + 8 * day).toISOString());
  });
});
