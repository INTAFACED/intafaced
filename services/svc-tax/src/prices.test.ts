import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createTradePrices } from './prices.js';

// TEST candles from a fake svc-trade market data door.
const T = Date.UTC(2026, 9, 20, 10, 30, 15); // 10:30:15
const MIN = Math.floor(T / 60_000) * 60_000;
const HOUR = Math.floor(T / 3_600_000) * 3_600_000;

type Answer = { status?: number; body: unknown };
function door(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const key = `${decodeURIComponent(url.pathname.replace('/api/v1/ohlcv/', ''))} ${url.searchParams.get('timeframe')}`;
    asked.push(key);
    const a = answers[key] ?? { status: 404, body: { code: 'BadSymbol' } };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { prices: createTradePrices('http://trade.test', fetchImpl), asked };
}

describe('price at time', () => {
  it('takes the close of the one-minute candle that contains the moment', async () => {
    const { prices } = door({ 'BTC/USDT 1m': { body: [[MIN, '64000', '65000', '63000', '64500.5', '1']] } });
    expect(await prices.priceAt('BTC', new Date(T))).toEqual({
      price: amt('64500.5'),
      market: 'BTC/USDT',
      timeframe: '1m',
      candleAt: new Date(MIN),
    });
  });

  it('a minute with no trade, or too many minutes since, moves to the hour candle', async () => {
    const later = door({
      'BTC/USDT 1m': { body: [[MIN + 120_000, '1', '1', '1', '1', '1']] }, // first trade after the moment: not its candle
      'BTC/USDT 1h': { body: [[HOUR, '1', '1', '1', '64400', '1']] },
    });
    expect(await later.prices.priceAt('BTC', new Date(T))).toMatchObject({ timeframe: '1h', price: amt('64400') });
    const far = door({
      'BTC/USDT 1m': { status: 400, body: { code: 'BadRequest', intafacedCode: 'trade.candles_range_point_cap' } },
      'BTC/USDT 1h': { body: [[HOUR, '1', '1', '1', '64300', '1']] },
    });
    expect(await far.prices.priceAt('BTC', new Date(T))).toMatchObject({ timeframe: '1h', price: amt('64300') });
  });

  it('a coin with no USDT market is priced on its USDC market', async () => {
    const { prices, asked } = door({ 'ETH/USDC 1m': { body: [[MIN, '1', '1', '1', '2600', '1']] } });
    expect(await prices.priceAt('ETH', new Date(T))).toMatchObject({ market: 'ETH/USDC', price: amt('2600') });
    expect(asked[0]).toBe('ETH/USDT 1m');
  });

  it('no candle anywhere is no price: never zero, never a guess', async () => {
    const { prices } = door({ 'BTC/USDT 1m': { body: [] }, 'BTC/USDT 1h': { body: [] }, 'BTC/USDT 1d': { body: [] } });
    expect(await prices.priceAt('BTC', new Date(T))).toBeNull();
  });

  it('any other refusal is a failed read, not a missing price', async () => {
    const { prices } = door({ 'BTC/USDT 1m': { status: 400, body: { code: 'BadRequest', intafacedCode: 'trade.invalid_since' } } });
    await expect(prices.priceAt('BTC', new Date(T))).rejects.toThrow(/trade.invalid_since/);
  });
});
