import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { ANALYTICS_MAX_PRINTS, computeAnalytics, parseAnalyticsWindow, registerMarketAnalyticsRoute } from './market-analytics.js';
import type { Market, PublicTapePrint } from './types.js';

const NOW = Date.parse('2026-11-06T08:00:00.000Z');
const print = (sequence: number, side: 'buy' | 'sell', qty: string, price: string, agoMs: number): PublicTapePrint => ({
  id: `p${sequence}`,
  side,
  qty: amt(qty),
  price: amt(price),
  quoteAmount: (amt(qty) * amt(price)) / amt('1'),
  sequence,
  ts: new Date(NOW - agoMs),
});

describe('market analytics', () => {
  it('the aggressor differential is buy-initiated minus sell-initiated quantity inside the named window', () => {
    const prints = [
      print(4, 'sell', '0.5', '101', 10_000),
      print(3, 'buy', '2', '102', 60_000),
      print(2, 'buy', '1', '100', 4 * 60_000),
      print(1, 'sell', '9', '99', 10 * 60_000), // outside 5m
    ];
    const a = computeAnalytics('BTC/USDT', '5m', prints, NOW, true);
    expect(a).toMatchObject({
      window: '5m',
      windowMs: 300_000,
      trades: 3,
      buyTrades: 2,
      sellTrades: 1,
      buyVolume: '3',
      sellVolume: '0.5',
      aggressorDifferential: '2.5',
      high: '102',
      low: '100',
      last: '101',
      complete: true,
      from: '2026-11-06T07:55:00.000Z',
      to: '2026-11-06T08:00:00.000Z',
    });
    expect(computeAnalytics('BTC/USDT', '1h', prints, NOW, true).aggressorDifferential).toBe('-6.5');
  });

  it('an empty window is zero with no prices, never a guess; a short read says how far it reaches', () => {
    expect(computeAnalytics('BTC/USDT', '1h', [], NOW, true)).toMatchObject({
      trades: 0,
      aggressorDifferential: '0',
      high: null,
      last: null,
    });
    const partial = computeAnalytics(
      'BTC/USDT',
      '24h',
      [print(2, 'buy', '1', '1', 1000), print(1, 'buy', '1', '1', 3_600_000)],
      NOW,
      false,
    );
    expect(partial).toMatchObject({ complete: false, coveredFrom: '2026-11-06T07:00:00.000Z' });
  });

  it('a blank window refuses, and so does one not on the list', () => {
    expect(parseAnalyticsWindow(undefined)).toMatchObject({ ok: false, code: 'trade.analytics_window_unset' });
    expect(parseAnalyticsWindow('  ')).toMatchObject({ ok: false, code: 'trade.analytics_window_unset' });
    expect(parseAnalyticsWindow('7m')).toMatchObject({ ok: false, code: 'trade.analytics_window_invalid' });
    expect(parseAnalyticsWindow('1h')).toEqual({ ok: true, window: '1h' });
  });

  it('serves GET /api/v1/analytics/:symbol from the public tape, newest first, at most the tape cap', async () => {
    const app = Fastify();
    const asked: Array<{ limit: number; sinceMs?: number }> = [];
    registerMarketAnalyticsRoute(app, {
      marketBySymbol: async (symbol) => (symbol === 'BTC/USDT' ? ({ id: 'm1', symbol } as Market) : null),
      publicTape: async (_id, limit, sinceMs) => {
        asked.push({ limit, sinceMs });
        return [print(1, 'buy', '1', '100', 1000)];
      },
      now: () => new Date(NOW),
    });
    const ok = await app.inject({ method: 'GET', url: '/api/v1/analytics/BTC%2FUSDT?window=1h' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ symbol: 'BTC/USDT', window: '1h', aggressorDifferential: '1', complete: true });
    expect(asked).toEqual([{ limit: ANALYTICS_MAX_PRINTS, sinceMs: NOW - 3_600_000 }]);
    const blank = await app.inject({ method: 'GET', url: '/api/v1/analytics/BTC%2FUSDT' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ intafacedCode: 'trade.analytics_window_unset' });
    const unknown = await app.inject({ method: 'GET', url: '/api/v1/analytics/NOPE%2FUSDT?window=1h' });
    expect(unknown.statusCode).toBe(404);
    expect(asked).toHaveLength(1);
    await app.close();
  });
});
