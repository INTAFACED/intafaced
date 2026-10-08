import { describe, expect, it } from 'vitest';
import type { QuoteFixture } from './data-tools.js';
import { readLiveNavigatorQuote, type NavigatorTradeDataPort } from './trade-data-port.js';

const MARKET_ID = 'btc-usdt';

function stubPort(quote: QuoteFixture | null): NavigatorTradeDataPort {
  return {
    listMarkets: async () => [],
    quote: async () => quote,
  };
}

function quoteWithLast(last: string | null): QuoteFixture {
  return {
    marketId: MARKET_ID,
    last,
    asOf: '2023-11-14T22:13:20.000Z',
    maxAgeMs: 30_000,
  };
}

describe('readLiveNavigatorQuote', () => {
  it('refuses a blank last as no live quote', async () => {
    const result = await readLiveNavigatorQuote(stubPort(quoteWithLast('')), MARKET_ID);
    expect(result).toEqual({ ok: false, reason: 'no_live_quote' });
  });

  it('refuses a whitespace last as no live quote', async () => {
    const result = await readLiveNavigatorQuote(stubPort(quoteWithLast('   ')), MARKET_ID);
    expect(result).toEqual({ ok: false, reason: 'no_live_quote' });
  });

  it('refuses a null last as no live quote', async () => {
    const result = await readLiveNavigatorQuote(stubPort(quoteWithLast(null)), MARKET_ID);
    expect(result).toEqual({ ok: false, reason: 'no_live_quote' });
  });

  it('returns a live quote when last is the decimal string 1.50', async () => {
    const quote = quoteWithLast('1.50');
    const result = await readLiveNavigatorQuote(stubPort(quote), MARKET_ID);
    expect(result).toEqual({ ok: true, quote });
    if (result.ok) {
      expect(result.quote.last).toBe('1.50');
    }
  });
});
