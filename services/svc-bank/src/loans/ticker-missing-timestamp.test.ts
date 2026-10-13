/**
 * A ticker timestamp that is not a number is not a mark. Stamping asOf with
 * the wall clock made an omitted field look fresh. Null and string timestamps
 * are the same refusal. A numeric timestamp stays asOf. The quote asset is
 * still price 1, quality index, and does not read a ticker.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { tickerPriceSource } from './prices.js';

const ASSET = 'asset-btc';
const QUOTE = 'asset-usd';

function fakeFetch(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => body,
  })) as typeof fetch;
}

describe('tickerPriceSource timestamp', () => {
  it('omits the mark when timestamp is absent', async () => {
    const source = tickerPriceSource({
      baseUrl: 'http://trade.test',
      fetchImpl: fakeFetch({ bid: '100', ask: '102', last: '101' }),
    });
    const marks = await source.marks([ASSET], QUOTE);
    expect(marks.has(ASSET)).toBe(false);
    expect(marks.size).toBe(0);
  });

  it('omits the mark when timestamp is null', async () => {
    const source = tickerPriceSource({
      baseUrl: 'http://trade.test',
      fetchImpl: fakeFetch({ bid: '100', ask: '102', last: '101', timestamp: null }),
    });
    const marks = await source.marks([ASSET], QUOTE);
    expect(marks.has(ASSET)).toBe(false);
    expect(marks.size).toBe(0);
  });

  it('omits the mark when timestamp is a string', async () => {
    const source = tickerPriceSource({
      baseUrl: 'http://trade.test',
      fetchImpl: fakeFetch({ bid: '100', ask: '102', last: '101', timestamp: '1700000000000' }),
    });
    const marks = await source.marks([ASSET], QUOTE);
    expect(marks.has(ASSET)).toBe(false);
    expect(marks.size).toBe(0);
  });

  it('publishes one mid mark when timestamp is a number', async () => {
    const source = tickerPriceSource({
      baseUrl: 'http://trade.test',
      fetchImpl: fakeFetch({ bid: '100', ask: '102', last: '99', timestamp: 1700000000000 }),
    });
    const marks = await source.marks([ASSET], QUOTE);
    expect(marks.size).toBe(1);
    const mark = marks.get(ASSET);
    expect(mark?.quality).toBe('mid');
    expect(mark?.asOf.getTime()).toBe(1700000000000);
    expect(mark?.price).toBe((parseAmount('100') + parseAmount('102')) / 2n);
  });

  it('prices the quote asset at 1 without a fetch timestamp', async () => {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      throw new Error('quote asset must not fetch a ticker');
    }) as typeof fetch;
    const source = tickerPriceSource({ baseUrl: 'http://trade.test', fetchImpl });
    const marks = await source.marks([QUOTE], QUOTE);
    expect(fetches).toBe(0);
    expect(marks.size).toBe(1);
    const mark = marks.get(QUOTE);
    expect(mark?.price).toBe(parseAmount('1'));
    expect(mark?.quality).toBe('index');
  });
});
