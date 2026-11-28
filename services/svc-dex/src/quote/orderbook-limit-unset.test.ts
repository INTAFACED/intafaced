/**
 * Unit card — MarketDataSource.orderBook unset refuse (no invented 50)
 *
 * 1. Promise: omitted / undefined / null limit throws (never invent 50).
 *    Owner-explicit 50 is a published window, not a git default.
 * 2. Break: `orderBook(symbol, limit = 50)` still invented book depth after
 *    DEX_QUOTE_DEPTH mill (#4018).
 * 3. Done bar: unset/null throw; 50 reads; market-data-source.ts has no
 *    `limit = 50` on orderBook.
 * 4. Class N
 * 5. Paths: market-data-source.ts orderBook()
 * 6. RED: omitting limit returns a 50-level book
 */
import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client/money';
import { MarketDataSource } from './market-data-source.js';
import type { TimestampedBook } from './venue.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

class LiveVenue extends MarketDataSource {
  readonly id = 'intachain-clob';
  readonly kind = 'external-dex' as const;
  readonly feeBps = 0;
  readonly settlementCost = 0n;
  lastLimit: number | undefined;

  constructor() {
    super({ quoteTtlMs: 2_000 });
  }

  protected async fetchDepth(symbol: string, limit: number): Promise<TimestampedBook> {
    this.lastLimit = limit;
    return {
      venueId: this.id,
      symbol,
      bids: [[amt('99'), amt('10')]],
      asks: [[amt('101'), amt('10')]],
      observedAt: NOW,
      sequence: 1,
      chainFinality: 'finalized',
    };
  }
}

describe('MarketDataSource orderBook limit refuse-closed', () => {
  it('unset limit refuses (no invent 50)', async () => {
    const venue = new LiveVenue();
    await expect(venue.orderBook('IFC-USD')).rejects.toThrow(/refuse to invent 50/);
    await expect(venue.orderBook('IFC-USD', undefined)).rejects.toThrow(/refuse to invent 50/);
    expect(venue.lastLimit).toBeUndefined();
  });

  it('null limit refuses (no invent 50)', async () => {
    const venue = new LiveVenue();
    await expect(venue.orderBook('IFC-USD', null)).rejects.toThrow(/refuse to invent 50/);
    expect(venue.lastLimit).toBeUndefined();
  });

  it('owner-explicit 50 is published (not invented)', async () => {
    const venue = new LiveVenue();
    const book = await venue.orderBook('IFC-USD', 50);
    expect(venue.lastLimit).toBe(50);
    expect(book.asks).toEqual([['101', '10']]);
    expect(book.bids).toEqual([['99', '10']]);
  });
});
