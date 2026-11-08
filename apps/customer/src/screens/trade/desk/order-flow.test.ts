import { describe, expect, it } from 'vitest';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import { buildLadder, DEFAULT_DOM, depthCurve, isDomSetting, spreadOf, stepOf, tapeView } from './order-flow';

const book = {
  bids: [
    ['100.03', '1'],
    ['100.02', '2'],
    ['100.01', '0.5'],
    ['99.99', '4'],
  ] as [string, string][],
  asks: [
    ['100.05', '1.5'],
    ['100.06', '0.25'],
    ['100.08', '3'],
  ] as [string, string][],
};

const trade = (id: string, at: number, price: string, amount: string, side: 'buy' | 'sell' = 'buy'): Trade => ({
  id,
  order: null,
  timestamp: at,
  datetime: new Date(at).toISOString(),
  symbol: 'BTC/USDT',
  type: null,
  side,
  takerOrMaker: null,
  price,
  amount,
  cost: '0',
  fee: null,
});

describe('ladder', () => {
  it('a step is whole ticks; below one tick it is refused', () => {
    expect(stepOf('0.01', 2)).toBe('0.02');
    expect(stepOf('0.01', 0)).toBeNull();
    expect(stepOf('0.01', 1.5)).toBeNull();
    expect(stepOf('0', 2)).toBeNull();
  });

  it('one tick: one row a level, highest first, the best bid and ask marked', () => {
    const ladder = buildLadder(book, '0.01');
    expect(ladder.rows.map((row) => row.price)).toEqual(['100.08', '100.06', '100.05', '100.03', '100.02', '100.01', '99.99']);
    expect(ladder.rows.find((row) => row.best === 'ask')?.price).toBe('100.05');
    expect(ladder.rows.find((row) => row.best === 'bid')?.price).toBe('100.03');
    expect(ladder.bidTotal).toBe('7.5');
    expect(ladder.askTotal).toBe('4.75');
  });

  it('two ticks: bids round down and asks round up to the step, sizes add up and the totals stay', () => {
    const ladder = buildLadder(book, '0.02');
    for (const row of ladder.rows) expect(Math.round(Number(row.price) * 100) % 2).toBe(0);
    const at = (price: string) => ladder.rows.find((row) => row.price === price);
    expect(at('100.02')?.bid).toBe('3'); // 100.03 and 100.02
    expect(at('100')?.bid).toBe('0.5'); // 100.01
    expect(at('99.98')?.bid).toBe('4');
    expect(at('100.06')?.ask).toBe('1.75'); // 100.05 and 100.06
    expect(at('100.08')?.ask).toBe('3');
    expect(ladder.rows.find((row) => row.best === 'bid')?.price).toBe('100.02');
    expect(ladder.rows.find((row) => row.best === 'ask')?.price).toBe('100.06');
    expect(ladder.bidTotal).toBe('7.5');
  });

  it('my working orders sit in their bucket, on their side', () => {
    const ladder = buildLadder(book, '0.02', [
      { side: 'buy', price: '100.01', remaining: '0.1' },
      { side: 'sell', price: '100.07', remaining: '0.2' },
      { side: 'buy', price: null, remaining: '1' },
    ]);
    expect(ladder.rows.find((row) => row.price === '100')?.myBid).toBe('0.1');
    expect(ladder.rows.find((row) => row.price === '100.08')?.myAsk).toBe('0.2');
  });

  it('an empty book gives no rows and invents no best price', () => {
    const ladder = buildLadder({ bids: [], asks: [] }, '0.01');
    expect(ladder.rows).toEqual([]);
    expect(ladder.bestBid).toBeNull();
    expect(ladder.bestAsk).toBeNull();
  });
});

describe('time and sales', () => {
  const trades = [
    trade('a', 1, '100', '0.5'),
    trade('b', 2, '100', '2'),
    trade('c', 3, '101', '0.01'),
    trade('d', 4, '101', '3', 'sell'),
    trade('e', 5, '101', '1', 'sell'),
  ];

  it('newest first; below the minimum is hidden and counted', () => {
    const view = tapeView(trades, { minAmount: '1', units: 'base', accumulate: false });
    expect(view.rows.map((row) => row.id)).toEqual(['e', 'd', 'b']);
    expect(view.hidden).toBe(2);
    expect(view.total).toBe(5);
  });

  it('the minimum in quote units compares the value', () => {
    const view = tapeView(trades, { minAmount: '150', units: 'quote', accumulate: false });
    expect(view.rows.map((row) => row.id)).toEqual(['d', 'b']);
    expect(view.hidden).toBe(3);
  });

  it('accumulate adds consecutive prints at one price and side', () => {
    const view = tapeView(trades, { minAmount: '', units: 'base', accumulate: true });
    expect(view.rows.map((row) => [row.price, row.side, row.amount, row.prints])).toEqual([
      ['101', 'sell', '4', 2],
      ['101', 'buy', '0.01', 1],
      ['100', 'buy', '2.5', 2],
    ]);
  });

  it('bars are permille of the largest row shown', () => {
    const view = tapeView(trades, { minAmount: '', units: 'base', accumulate: false });
    expect(view.rows.find((row) => row.id === 'd')?.bar).toBe('1000');
    expect(view.rows.find((row) => row.id === 'e')?.bar).toBe('333');
  });
});

describe('depth curve', () => {
  it('cumulates outward from the best price, in base and quote', () => {
    const curve = depthCurve(book);
    expect(curve.bids.map((p) => p.cumulative)).toEqual(['1', '3', '3.5', '7.5']);
    expect(curve.asks.map((p) => p.cumulative)).toEqual(['1.5', '1.75', '4.75']);
    expect(curve.asks[0]?.cumulativeValue).toBe('150.075');
    expect(curve.bidTotal).toBe('7.5');
  });
});

describe('spread and settings', () => {
  it('spread is the ask less the bid; none on a crossed or one-sided book', () => {
    expect(spreadOf('100.03', '100.05')).toBe('0.02');
    expect(spreadOf(null, '100.05')).toBeNull();
    expect(spreadOf('101', '100')).toBeNull();
  });

  it('a stored setting is read only when every field is valid', () => {
    expect(isDomSetting(DEFAULT_DOM)).toBe(true);
    expect(isDomSetting({ ...DEFAULT_DOM, stepTicks: 3 })).toBe(false);
    expect(isDomSetting({ ...DEFAULT_DOM, minAmount: 'abc' })).toBe(false);
    expect(isDomSetting(null)).toBe(false);
  });
});
