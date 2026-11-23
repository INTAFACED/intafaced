import { describe, expect, it } from 'vitest';
import { buildLadder, depthCurve, tapeView, type TapePrint } from './order-flow';
import { flowMarketOf, printsReach, venueBookAsOrderBook, venuePrintsAsTape, venueQueueEstimate } from './venue-flow';

const read = {
  venueId: 'test-venue',
  asOf: '2026-11-16T10:00:00.000Z',
  value: {
    symbol: 'BTC-USDC',
    bids: [
      { price: '59995', amount: '0.003' },
      { price: '59990', amount: '1' },
    ],
    asks: [{ price: '60010', amount: '1' }],
  },
};
const T0 = Date.parse(read.asOf);
const print = (id: string, at: number, price: string, amount: string, side: 'buy' | 'sell' | null): TapePrint => ({
  id,
  timestamp: at,
  side,
  price,
  amount,
});

describe('the venue book and prints as the DOM reads them', () => {
  it('keeps every level and stamps the read with its as-of time, so the ladder and the depth chart show one read', () => {
    const book = venueBookAsOrderBook(read);
    expect(book.bids).toEqual([
      ['59995', '0.003'],
      ['59990', '1'],
    ]);
    expect(book.asks).toEqual([['60010', '1']]);
    expect(book.nonce).toBe(T0);
    expect(book.timestamp).toBe(T0);
    const ladder = buildLadder(book, '1');
    const curve = depthCurve(book);
    expect(ladder.bidTotal).toBe(curve.bidTotal);
    expect(ladder.bestBid).toBe('59995');
    expect(ladder.bestAsk).toBe('60010');
  });

  it('maps prints to the tape and keeps an unnamed taker without a side', () => {
    const tape = venuePrintsAsTape([
      { tradeId: 'a', symbol: 'BTC-USDC', price: '60010', amount: '0.5', takerSide: 'buy', tradedAt: read.asOf },
      { tradeId: 'b', symbol: 'BTC-USDC', price: '59990', amount: '0.2', takerSide: null, tradedAt: read.asOf },
    ]);
    expect(tape.map((p) => [p.id, p.side, p.timestamp])).toEqual([
      ['a', 'buy', T0],
      ['b', null, T0],
    ]);
    expect(tapeView(tape, { minAmount: '0.3', units: 'base', accumulate: false })).toMatchObject({ hidden: 1, total: 2 });
  });

  it('reads the venue market as the DOM market', () => {
    const m = { symbol: 'BTC-USDC', baseAsset: 'BTC', quoteAsset: 'USDC', tickSize: '1', lotSize: '0.0001' };
    expect(flowMarketOf(m)).toEqual({ symbol: 'BTC-USDC', base: 'BTC', quote: 'USDC', tickSize: '1', lotSize: '0.0001', open: true });
  });
});

describe('my place in the venue queue', () => {
  const book = venueBookAsOrderBook(read);
  const base = { side: 'buy' as const, price: '59995', remaining: '0.001', book, tapeAsOfMs: T0, printsComplete: true };

  it('puts at most the level less my own size ahead of me, from the published book', () => {
    const q = venueQueueEstimate({ ...base, prints: [], windowSeconds: 300 });
    expect(q).toMatchObject({ kind: 'ready', levelTotal: '0.003', remaining: '0.001', sizeAheadAtMost: '0.002' });
  });

  it('counts only prints at or through my price, taker on the other side, inside the window', () => {
    const prints = [
      print('in', T0 - 10_000, '59995', '0.001', 'sell'),
      print('through', T0 - 20_000, '59990', '0.0005', 'sell'),
      print('above', T0 - 5_000, '60000', '1', 'sell'),
      print('taker-buy', T0 - 5_000, '59995', '1', 'buy'),
      print('no-side', T0 - 5_000, '59995', '1', null),
      print('old', T0 - 301_000, '59995', '1', 'sell'),
      print('after', T0 + 1, '59995', '1', 'sell'),
    ];
    const q = venueQueueEstimate({ ...base, prints, windowSeconds: 300 });
    expect(q.kind).toBe('ready');
    if (q.kind !== 'ready' || q.chance.kind !== 'estimate') throw new Error('an estimate');
    expect(q.chance).toMatchObject({ tradedThrough: '0.0015', sizeToFill: '0.003', ratio: '0.5', windowStartMs: T0 - 300_000 });
  });

  it('floors the chance to 4 places and caps it at one', () => {
    const third = venueQueueEstimate({ ...base, prints: [print('x', T0, '59995', '0.001', 'sell')], windowSeconds: 60 });
    expect(third.kind === 'ready' && third.chance.kind === 'estimate' && third.chance.ratio).toBe('0.3333');
    const all = venueQueueEstimate({ ...base, prints: [print('x', T0, '59990', '5', 'sell')], windowSeconds: 60 });
    expect(all.kind === 'ready' && all.chance.kind === 'estimate' && all.chance.ratio).toBe('1');
    const none = venueQueueEstimate({ ...base, prints: [], windowSeconds: 60 });
    expect(none.kind === 'ready' && none.chance.kind === 'estimate' && none.chance.ratio).toBe('0');
  });

  it('a sell counts buys at or above its price', () => {
    const q = venueQueueEstimate({
      ...base,
      side: 'sell',
      price: '60010',
      remaining: '0.5',
      prints: [print('up', T0, '60020', '0.25', 'buy'), print('down', T0, '60000', '1', 'buy')],
      windowSeconds: 60,
    });
    expect(q).toMatchObject({ kind: 'ready', sizeAheadAtMost: '0.5', chance: { tradedThrough: '0.25', sizeToFill: '1', ratio: '0.25' } });
  });

  it('shows no chance while the owner has not set the window, never a default', () => {
    for (const windowSeconds of [null, 0, -5, 1.5]) {
      const q = venueQueueEstimate({ ...base, prints: [print('x', T0, '59995', '1', 'sell')], windowSeconds });
      expect(q).toMatchObject({ kind: 'ready', chance: { kind: 'unset' } });
    }
  });

  it('says not in the book when my price is not a published level, and never reads a negative size ahead', () => {
    expect(venueQueueEstimate({ ...base, price: '59000', prints: [], windowSeconds: 60 })).toEqual({ kind: 'not_in_book' });
    expect(venueQueueEstimate({ ...base, remaining: '0', prints: [], windowSeconds: 60 })).toEqual({ kind: 'not_in_book' });
    const moved = venueQueueEstimate({ ...base, remaining: '0.01', prints: [], windowSeconds: 60 });
    expect(moved).toMatchObject({ kind: 'ready', sizeAheadAtMost: '0' });
  });

  it('knows when a prints read reaches back past the window', () => {
    const prints = [print('a', T0, '1', '1', 'buy'), print('b', T0 - 1000, '1', '1', 'buy')];
    expect(printsReach(prints, 500, T0 - 60_000)).toBe(true);
    expect(printsReach(prints, 2, T0 - 60_000)).toBe(false);
    expect(printsReach(prints, 2, T0 - 500)).toBe(true);
  });
});
