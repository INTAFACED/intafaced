import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createTradePrices } from './prices.js';

// TEST candles from a fake svc-trade market data door.
const T = Date.UTC(2026, 9, 20, 10, 30, 15); // 10:30:15
const MIN = Math.floor(T / 60_000) * 60_000;
const HOUR = Math.floor(T / 3_600_000) * 3_600_000;

type Answer = { status?: number; body: unknown } | 'throw';
function door(answers: Record<string, Answer>) {
  const asked: Array<{ key: string; since: number }> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const key = `${decodeURIComponent(url.pathname.replace('/api/v1/ohlcv/', ''))} ${url.searchParams.get('timeframe')}`;
    asked.push({ key, since: Number(url.searchParams.get('since')) });
    const a = answers[key] ?? { status: 404, body: { code: 'BadSymbol' } };
    if (a === 'throw') throw new Error('connection reset');
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { prices: createTradePrices('http://trade.test', fetchImpl), asked };
}
const c = (openAt: number, close: string) => [openAt, '1', '1', '1', close, '1'];

describe('price at time', () => {
  it('one-minute candles: the close of the minute it arrived in', async () => {
    const { prices, asked } = door({ 'BTC/USDT 1m': { body: [c(MIN - 120_000, '64000'), c(MIN, '64500.5'), c(MIN + 60_000, '70000')] } });
    expect(await prices.priceAt('BTC', new Date(T))).toEqual({
      price: amt('64500.5'),
      market: 'BTC/USDT',
      timeframe: '1m',
      candleAt: new Date(MIN),
    });
    // It reads an hour back from the arrival's minute.
    expect(asked[0]).toEqual({ key: 'BTC/USDT 1m', since: MIN - 60 * 60_000 });
  });

  it('a minute with no trade uses the last minute before it that traded, never a later one', async () => {
    const { prices } = door({ 'BTC/USDT 1m': { body: [c(MIN - 300_000, '64100'), c(MIN + 120_000, '70000')] } });
    expect(await prices.priceAt('BTC', new Date(T))).toMatchObject({ timeframe: '1m', price: amt('64100'), candleAt: new Date(MIN - 300_000) });
  });

  it('too many minutes since: an hourly candle that had ended by the arrival, never the hour it arrived in', async () => {
    const { prices } = door({
      'BTC/USDT 1m': { status: 400, body: { code: 'BadRequest', intafacedCode: 'trade.candles_range_point_cap' } },
      'BTC/USDT 1h': { body: [c(HOUR - 3_600_000, '64300'), c(HOUR, '69000')] },
    });
    expect(await prices.priceAt('BTC', new Date(T))).toMatchObject({ timeframe: '1h', price: amt('64300'), candleAt: new Date(HOUR - 3_600_000) });
  });

  it('a coin with no USDT market is priced on its USDC market', async () => {
    const { prices, asked } = door({ 'ETH/USDC 1m': { body: [c(MIN, '2600')] } });
    expect(await prices.priceAt('ETH', new Date(T))).toMatchObject({ market: 'ETH/USDC', price: amt('2600') });
    expect(asked[0]!.key).toBe('ETH/USDT 1m');
  });

  it('no candle anywhere is no price: never zero, never a guess', async () => {
    const { prices } = door({ 'BTC/USDT 1m': { body: [] }, 'BTC/USDT 1h': { body: [] }, 'BTC/USDT 1d': { body: [] } });
    expect(await prices.priceAt('BTC', new Date(T))).toBeNull();
  });

  it('one failed read moves on to the next candle size; only when nothing answers is it a failure', async () => {
    const recovered = door({ 'BTC/USDT 1m': 'throw', 'BTC/USDT 1h': { body: [c(HOUR - 3_600_000, '64200')] } });
    expect(await recovered.prices.priceAt('BTC', new Date(T))).toMatchObject({ timeframe: '1h', price: amt('64200') });
    const down = door({ 'BTC/USDT 1m': 'throw', 'BTC/USDT 1h': 'throw', 'BTC/USDT 1d': 'throw', 'BTC/USDC 1m': 'throw', 'BTC/USDC 1h': 'throw', 'BTC/USDC 1d': 'throw' });
    await expect(down.prices.priceAt('BTC', new Date(T))).rejects.toThrow(/connection reset/);
  });
});
