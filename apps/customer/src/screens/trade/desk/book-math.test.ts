import { describe, expect, it } from 'vitest';
import { buildBook, buyShare, groupLevels } from './book-math';

const bids = [
  ['65005.6', '0.04614'],
  ['65004.99', '0.5'],
  ['64947.06', '0.09238'],
] as const;
const asks = [
  ['65083.66', '0.04609'],
  ['65083.67', '1'],
  ['65142.2', '0.0921'],
] as const;

describe('groupLevels', () => {
  it('rounds bids down and adds the amounts of a bucket exactly', () => {
    const buckets = groupLevels(bids, 'bid', '10');
    // 65005.6 and 65004.99 both land in 65000 (0.04614 + 0.5); 64947.06 lands in 64940.
    expect(buckets).toHaveLength(2);
    expect(buckets[0]!.price.toString()).toBe('65000000000000000000000');
    expect(buckets[0]!.amount.toString()).toBe('546140000000000000');
    expect(buckets[1]!.price.toString()).toBe('64940000000000000000000');
  });

  it('keeps a bid at its own bucket and never improves an ask', () => {
    const askBuckets = groupLevels(asks, 'ask', '1');
    // 65083.66 and 65083.67 both round UP to 65084 and merge: 0.04609 + 1 = 1.04609.
    expect(askBuckets).toHaveLength(2);
    expect(askBuckets[0]!.amount.toString()).toBe('1046090000000000000');
  });

  it('returns levels untouched in order when there is no grouping', () => {
    const plain = groupLevels(bids, 'bid', null);
    expect(plain).toHaveLength(3);
    expect(plain[0]!.price > plain[1]!.price).toBe(true);
  });

  it('skips levels with an unreadable or zero price or amount', () => {
    expect(
      groupLevels(
        [
          ['x', '1'],
          ['1', '0'],
          ['2', '3'],
        ],
        'ask',
        null,
      ),
    ).toHaveLength(1);
  });
});

describe('buildBook', () => {
  it('lists asks highest first, bids best first, with running totals', () => {
    const view = buildBook(bids, asks, null, 10);
    expect(view.asks.map((r) => r.price)).toEqual(['65142.2', '65083.67', '65083.66']);
    expect(view.bids.map((r) => r.price)).toEqual(['65005.6', '65004.99', '64947.06']);
    expect(view.bids.map((r) => r.total)).toEqual(['0.04614', '0.54614', '0.63852']);
    expect(view.asks.map((r) => r.total)).toEqual(['1.13819', '1.04609', '0.04609']);
    expect(view.bestBid).toBe('65005.6');
    expect(view.bestAsk).toBe('65083.66');
  });

  it('cuts to the rows that fit, nearest the middle first', () => {
    const view = buildBook(bids, asks, null, 2);
    expect(view.asks.map((r) => r.price)).toEqual(['65083.67', '65083.66']);
    expect(view.bids.map((r) => r.price)).toEqual(['65005.6', '65004.99']);
  });

  it('scales the bars against the widest side, as whole permille', () => {
    const view = buildBook(bids, asks, null, 10);
    // Widest total is the asks' 1.13819: that bar is 1000, the best ask (0.04609) is 40.
    expect(view.asks[0]!.depth).toBe('1000');
    expect(view.asks[2]!.depth).toBe('40');
    expect(view.bids[2]!.depth).toBe('560');
  });

  it('handles an empty book', () => {
    const view = buildBook([], [], null, 10);
    expect(view.asks).toEqual([]);
    expect(view.bids).toEqual([]);
    expect(view.bestBid).toBeNull();
    expect(buyShare(view.bidTotal, view.askTotal)).toBeNull();
  });
});

describe('buyShare', () => {
  it('is the buy side share to one decimal, summing to 100', () => {
    expect(buyShare('1', '1')).toEqual({ buy: '50.0', sell: '50.0' });
    expect(buyShare('0.63852', '1.13819')).toEqual({ buy: '35.9', sell: '64.1' });
  });
});
