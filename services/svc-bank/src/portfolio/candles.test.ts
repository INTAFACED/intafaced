import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { closeAt, httpCloseSeries, type CloseSeries } from './candles.js';

// Every price is TEST data.
const H = 3_600_000;
const M5 = 300_000;
const T0 = Date.UTC(2026, 9, 20, 15);

type Answer = { status: number; body: unknown };
/** A stand-in for svc-trade's public candles: one answer per market and timeframe, and every URL asked for. */
function trade(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    const [, market, timeframe] = /ohlcv\/([^?]+)\?timeframe=([^&]+)/.exec(url)!;
    const answer = answers[`${decodeURIComponent(market!)} ${timeframe}`] ?? {
      status: 404,
      body: { code: 'BadSymbol', intafacedCode: 'trade.market_not_found' },
    };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}
const candle = (openAt: number, close: string) => [openAt, close, close, close, close, '1'];

describe('httpCloseSeries', () => {
  it('passes over a listed USDT market that never traded for the USDC one, as the Money total does', async () => {
    const { fetchImpl } = trade({
      'XYZ/USDT 5m': { status: 200, body: [] },
      'XYZ/USDT 1h': { status: 200, body: [] },
      'XYZ/USDT 1d': { status: 200, body: [] },
      'XYZ/USDC 5m': { status: 200, body: [candle(T0 - M5, '2'), candle(T0, '3')] },
    });
    const series = await httpCloseSeries({ baseUrl: 'http://trade', fetchImpl, now: () => new Date(T0 + H) }).closes(
      'XYZ',
      '5m',
      new Date(T0),
      new Date(T0 + H),
    );
    expect(series?.market).toBe('XYZ/USDC');
    expect(closeAt(series!, '5m', T0, false)).toBe(amt('2'));
  });

  it('a market with no candle at all is kept, so the coin reads missing, never zero; no market at all is null', async () => {
    const { fetchImpl } = trade({ 'XYZ/USDT 5m': { status: 200, body: [] }, 'XYZ/USDT 1h': { status: 200, body: [] } });
    const source = httpCloseSeries({ baseUrl: 'http://trade', fetchImpl, now: () => new Date(T0 + H) });
    const series = await source.closes('XYZ', '5m', new Date(T0), new Date(T0 + H));
    expect(series).toEqual({ market: 'XYZ/USDT', candles: [] });
    expect(closeAt(series!, '5m', T0 + H, true)).toBeNull();
    expect(await source.closes('NOPE', '5m', new Date(T0), new Date(T0 + H))).toBeNull();
  });

  it('starts a thin market from its last hourly close of the same day before the start, not the day before', async () => {
    const { fetchImpl, asked } = trade({
      // Nothing traded in the 5 minutes before 15:00; it last traded at 10:00 that day.
      'BTC/USDT 5m': { status: 200, body: [candle(T0 + 2 * M5, '61000')] },
      'BTC/USDT 1h': { status: 200, body: [candle(T0 - 5 * H, '60000'), candle(T0 + 2 * M5, '61000')] },
      'BTC/USDT 1d': { status: 200, body: [candle(Date.UTC(2026, 9, 19), '59000')] },
    });
    const series = await httpCloseSeries({ baseUrl: 'http://trade', fetchImpl, now: () => new Date(T0 + H) }).closes(
      'BTC',
      '5m',
      new Date(T0),
      new Date(T0 + H),
    );
    expect(closeAt(series!, '5m', T0, false)).toBe(amt('60000'));
    expect(asked.some((url) => url.includes('timeframe=1d'))).toBe(false);
  });

  it('refuses rather than draws from part of the data when a read fails', async () => {
    const { fetchImpl } = trade({ 'BTC/USDT 5m': { status: 503, body: {} } });
    await expect(
      httpCloseSeries({ baseUrl: 'http://trade', fetchImpl }).closes('BTC', '5m', new Date(T0), new Date(T0 + H)),
    ).rejects.toThrow();
  });
});

describe('closeAt', () => {
  const series: CloseSeries = { market: 'BTC/USDT', candles: [0, 1, 2, 3, 5].map((h) => [T0 + h * H, amt(String(100 + h))] as const) };
  it('takes the last candle ended by T, and the open one only at the live end', () => {
    expect(closeAt(series, '1h', T0, false)).toBeNull();
    expect(closeAt(series, '1h', T0 + H, false)).toBe(amt('100'));
    expect(closeAt(series, '1h', T0 + H - 1, false)).toBeNull();
    expect(closeAt(series, '1h', T0 + 4 * H + 30, false)).toBe(amt('103'));
    // Through a gap (no candle opened at 4h), the last close stands.
    expect(closeAt(series, '1h', T0 + 5 * H, false)).toBe(amt('103'));
    expect(closeAt(series, '1h', T0 + 5 * H + 1, true)).toBe(amt('105'));
    expect(closeAt(series, '1h', T0 + 9 * H, false)).toBe(amt('105'));
  });
});
