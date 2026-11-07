import { describe, expect, it } from 'vitest';
import { percentOf, queuePositionSchema, windowWords } from './queue-position';

describe('queue position', () => {
  it('a probability is shown as a floored percent with one decimal, never above 100%', () => {
    expect(percentOf('0.428571428571428571')).toBe('42.8%');
    expect(percentOf('1')).toBe('100.0%');
    expect(percentOf('0')).toBe('0.0%');
    expect(percentOf('1.2')).toBeNull();
    expect(percentOf('x')).toBeNull();
  });

  it('the window reads in minutes when whole', () => {
    expect(windowWords(300)).toEqual({ n: 5, unit: 'minutes' });
    expect(windowWords(90)).toEqual({ n: 90, unit: 'seconds' });
  });

  it('an answer must come from the native queue', () => {
    const base = {
      orderId: 'o',
      symbol: 'BTC/USDT',
      side: 'buy',
      price: '100',
      remaining: '1',
      ordersAhead: 1,
      sizeAhead: '1.5',
      asOf: '2026-11-07T08:00:00.000Z',
      fillProbability: null,
      fillProbabilityRefusal: 'trade.queue_probability_unset',
      windowSeconds: null,
      tradedInWindow: null,
    };
    expect(queuePositionSchema.safeParse({ ...base, source: 'native_l3' }).success).toBe(true);
    expect(queuePositionSchema.safeParse({ ...base, source: 'l2' }).success).toBe(false);
  });
});
