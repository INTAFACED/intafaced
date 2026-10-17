import { describe, expect, it } from 'vitest';
import { heroPrice, highLow, isUnpricedMarket, moveSince, startsLate, tickerMove } from './coin-math';
import type { Candle, Loadable, TickerRow } from './deps';

const candle = (t: number, o: string, c: string): Candle => ({ t, o, h: c, l: o, c, v: '1', filled: false });

describe('moveSince: the change since the range started, in exact arithmetic', () => {
  const candles = [candle(0, '66000.00', '66100.00'), candle(1, '66100.00', '67000.00')];
  it('measures from the first candle open', () => {
    const move = moveSince(candles, '67812.40')!;
    expect(move.base).toBe('66000.00');
    expect(move.change).toBe('1812.4');
    expect(move.changeRatio).toBe('0.027460606060606061');
    expect(move.direction).toBe('up');
  });
  it('reads a fall as down, with the exact amount', () => {
    const move = moveSince(candles, '65000.5')!;
    expect(move.change).toBe('-999.5');
    expect(move.direction).toBe('down');
  });
  it('is flat when nothing moved', () => {
    expect(moveSince(candles, '66000')!.direction).toBe('flat');
  });
  it('does not guess when a side is unknown', () => {
    expect(moveSince([], '1')).toBeNull();
    expect(moveSince(candles, null)).toBeNull();
    expect(moveSince(candles, 'abc')).toBeNull();
  });
  it('has no ratio when the range started at 0', () => {
    expect(moveSince([candle(0, '0', '1')], '2')!.changeRatio).toBeNull();
  });
  it('keeps tiny moves exact (no float rounding)', () => {
    expect(moveSince([candle(0, '0.1', '0.1')], '0.3')!.change).toBe('0.2');
  });
});

describe('heroPrice: the string HeroNumber animates', () => {
  it('rounds to the tick size, half up, never through a float', () => {
    expect(heroPrice('67812.405', '0.01')).toEqual({ value: '67812.41', decimals: 2 });
    expect(heroPrice('0.41204', '0.0001')).toEqual({ value: '0.4120', decimals: 4 });
  });
  it('is unknown when the price is', () => {
    expect(heroPrice(null, '0.01')).toEqual({ value: null, decimals: 2 });
  });
  it('falls back to two decimals without a tick', () => {
    expect(heroPrice('1.5', null).decimals).toBe(2);
  });
});

describe('highLow: the two labels on the line', () => {
  it('names the highest and lowest close', () => {
    const list = [candle(0, '1', '5'), candle(1, '1', '9'), candle(2, '1', '3'), candle(3, '1', '4')];
    expect(highLow(list)).toEqual({ high: { index: 1, price: '9' }, low: { index: 2, price: '3' } });
  });
  it('has none for a line that never moves', () => {
    expect(highLow([candle(0, '1', '2'), candle(1, '1', '2')])).toBeNull();
    expect(highLow([])).toBeNull();
  });
});

describe('startsLate: less history than the range asks for', () => {
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 9, 14, 12, 0, 0);
  it('is false when the first candle is where the range starts', () => {
    const start = now - 168 * HOUR + HOUR;
    expect(startsLate([candle(start, '1', '1')], HOUR, 168 * HOUR, now)).toBe(false);
  });
  it('is true for a market that is three days old on a one week range', () => {
    expect(startsLate([candle(now - 72 * HOUR, '1', '1')], HOUR, 168 * HOUR, now)).toBe(true);
  });
  it('is false with no candles', () => {
    expect(startsLate([], HOUR, 168 * HOUR, now)).toBe(false);
  });
});

const ticker = (patch: Partial<TickerRow>): TickerRow => ({
  symbol: 'BTC/USDT',
  last: '64772.05',
  bid: null,
  ask: null,
  open24h: '65120.39',
  high24h: null,
  low24h: null,
  change24h: '-348.34',
  changePct24h: '-0.005349',
  baseVolume24h: null,
  quoteVolume24h: null,
  windowStart: null,
  source: 'server',
  ...patch,
});

describe('tickerMove: the past day as the ticker states it, for the 1D line while its candles are out', () => {
  it('measures from the 24 h open to the last price, exactly', () => {
    const move = tickerMove(ticker({}))!;
    expect(move.base).toBe('65120.39');
    expect(move.change).toBe('-348.34');
    expect(move.direction).toBe('down');
    expect(move.changeRatio).toBe('-0.005349169438327995');
  });
  it('does not guess without an open, a last price or a ticker', () => {
    expect(tickerMove(ticker({ open24h: null }))).toBeNull();
    expect(tickerMove(ticker({ last: null }))).toBeNull();
    expect(tickerMove(null)).toBeNull();
  });
});

describe('isUnpricedMarket: a listed market with no open book says "no market", it is not a fault', () => {
  const refused = (code: string): Loadable<TickerRow> => ({ status: 'refused', code });
  it('is true when the exchange answers that no book is open or the market is missing', () => {
    expect(isUnpricedMarket(refused('trade.no_book'))).toBe(true);
    expect(isUnpricedMarket(refused('trade.matching_market_missing'))).toBe(true);
    expect(isUnpricedMarket(refused('trade.market_not_found'))).toBe(true);
  });
  it('is false for any other refusal, a failed read, a loading ticker or a priced one', () => {
    expect(isUnpricedMarket(refused('ExchangeError'))).toBe(false);
    expect(isUnpricedMarket(refused('scope.denied'))).toBe(false);
    expect(isUnpricedMarket({ status: 'loading' })).toBe(false);
    expect(isUnpricedMarket({ status: 'error', retry: () => undefined })).toBe(false);
    expect(isUnpricedMarket({ status: 'ready', data: ticker({}), asOf: 0 })).toBe(false);
  });
});
