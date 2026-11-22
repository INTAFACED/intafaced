/**
 * Unit card — consolidateBook refuse when depth unpublished
 *
 * 1. Promise: omitted / null / undefined / 0 / NaN depth →
 *    venue.consolidated_book.depth_unset (no invented 50).
 *    Owner-explicit 50 is a published number, not a git default.
 * 2. Break: consolidateBook treating missing depth as 50 lets blank look published.
 * 3. Done bar: consolidateBook refuses before any venue fetch; source has no default 50.
 * 4. Class M
 * 5. Paths: consolidated-book.ts consolidateBook
 * 6. RED: unset book succeeds or source git-defaults 50
 */
import { describe, expect, it } from 'vitest';
import type { OrderBook } from '@intafaced/exchange-contract';
import { CONSOLIDATED_BOOK_DEPTH_UNSET, ConsolidatedBookRefusedError, consolidateBook } from './consolidated-book.js';
import type { LiquiditySource, QuoteRequest, VenueHealth } from './source.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function liveVenue(): LiquiditySource {
  const health: VenueHealth = { healthy: true, latencyMs: 10, lastUpdate: NOW };
  return {
    id: 'venue-a',
    kind: 'external-cex',
    capabilities: ['quote', 'orderbook', 'submit'],
    health: () => health,
    markets: async () => [],
    quote: async (req: QuoteRequest) => ({
      venueId: 'venue-a',
      symbol: req.symbol,
      side: req.side,
      amount: req.amount,
      price: 1n,
      feeBps: 0,
      expiresAt: NOW,
    }),
    orderBook: async (symbol: string): Promise<OrderBook> => ({
      symbol,
      bids: [['99', '1']],
      asks: [['101', '1']],
      timestamp: NOW.getTime(),
      datetime: NOW.toISOString(),
      nonce: 1,
    }),
    submit: async () => {
      throw new Error('consolidated-book depth-unset tests do not submit');
    },
  };
}

describe('consolidateBook depth unpublished', () => {
  it('omitted / null / undefined depth refuses (does not invent 50)', async () => {
    const sources = [liveVenue()];
    await expect(consolidateBook('BTC/USDT', sources)).rejects.toMatchObject({
      name: 'ConsolidatedBookRefusedError',
      code: CONSOLIDATED_BOOK_DEPTH_UNSET,
    } satisfies Partial<ConsolidatedBookRefusedError>);
    await expect(consolidateBook('BTC/USDT', sources, {})).rejects.toMatchObject({
      code: CONSOLIDATED_BOOK_DEPTH_UNSET,
    });
    await expect(consolidateBook('BTC/USDT', sources, { depth: undefined })).rejects.toMatchObject({
      code: CONSOLIDATED_BOOK_DEPTH_UNSET,
    });
    await expect(consolidateBook('BTC/USDT', sources, { depth: null })).rejects.toMatchObject({
      code: CONSOLIDATED_BOOK_DEPTH_UNSET,
    });
  });

  it('NaN / 0 depth refuses (does not invent 50)', async () => {
    const sources = [liveVenue()];
    await expect(consolidateBook('BTC/USDT', sources, { depth: Number.NaN })).rejects.toMatchObject({
      code: CONSOLIDATED_BOOK_DEPTH_UNSET,
    });
    await expect(consolidateBook('BTC/USDT', sources, { depth: 0 })).rejects.toMatchObject({
      code: CONSOLIDATED_BOOK_DEPTH_UNSET,
    });
  });

  it('owner-explicit 50 consolidates', async () => {
    const book = await consolidateBook('BTC/USDT', [liveVenue()], { depth: 50, now: NOW });
    expect(book.bids).toHaveLength(1);
    expect(book.asks).toHaveLength(1);
  });
});
