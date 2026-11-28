/**
 * Unit card — MarketDataSource.quote refuse hardcoded depth 50
 *
 * 1. Promise: unpublished / 0 / NaN depth throws (never invent 50).
 *    Owner-explicit 50 (DEX_QUOTE_DEPTH) is a published window, not a git default.
 * 2. Break: `quote()` still called `depth(symbol, 50)` after orderBook mill (#4103).
 * 3. Done bar: unset/0/NaN throw before fetch; 50 reads; no `depth(request.symbol, 50)`.
 *    venue-set forwards DEX_QUOTE_DEPTH (no second invented number).
 * 4. Class N
 * 5. Paths: market-data-source.ts quote(); venue-set.ts depth: env.DEX_QUOTE_DEPTH
 * 6. RED: quote() with unset depth returns a book walked at 50
 */
import { describe, expect, it, vi } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client/money';
import { MarketDataSource } from './market-data-source.js';
import { venuesFor, type VenueSetEnv } from './venue-set.js';
import type { TimestampedBook } from './venue.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const buyOne = { symbol: 'IFC-USD', side: 'buy' as const, amount: amt('1') };

class LiveVenue extends MarketDataSource {
  readonly id = 'intachain-clob';
  readonly kind = 'external-dex' as const;
  readonly feeBps = 0;
  readonly settlementCost = 0n;
  lastLimit: number | undefined;

  constructor(depth?: number) {
    super({ quoteTtlMs: 2_000, ...(depth !== undefined ? { depth } : {}) });
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

describe('MarketDataSource quote depth refuse-closed', () => {
  it('venuesFor hands DEX_QUOTE_DEPTH to every venue (no second invented number)', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      asked.push(String(url));
      throw new Error('TEST: no venue answers');
    });
    try {
      const env = (depth: number | undefined): VenueSetEnv => ({
        INDEXER_URL: 'http://indexer.test',
        MATCHING_URL: 'http://matching.test',
        QUOTE_MAX_AGE_MS: 2_000,
        DEX_QUOTE_DEPTH: depth,
        DEX_CLOB_FEE_BPS: 10,
        DEX_CLOB_SETTLEMENT_COST: '0',
        DEX_INTERNAL_BOOK_ENABLED: true,
        DEX_INTERNAL_BOOK_FEE_BPS: 20,
        DEX_EXTERNAL_VENUES: [],
      });
      const unset = venuesFor(env(undefined), 'ROW');
      expect(unset.map((v) => v.id)).toEqual(['intachain-clob', 'internal-book']);
      for (const venue of unset) await expect(venue.quote(buyOne)).rejects.toThrow(/refuse to invent 50/);
      expect(asked).toEqual([]);
      for (const venue of venuesFor(env(7), 'ROW')) await venue.quote(buyOne).catch(() => null);
      // Each venue asked its own host for the published depth, and only that depth.
      const decoded = asked.map((url) => decodeURIComponent(url));
      expect(decoded.filter((url) => url.startsWith('http://matching.test/'))).toEqual([
        'http://matching.test/markets/IFC-USD/depth?limit=7',
      ]);
      const book = decoded.filter((url) => url.startsWith('http://indexer.test/') && url.includes('"depth"'));
      expect(book).toHaveLength(1);
      expect(book[0]).toContain('"depth":7');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('unset depth refuses (no invent 50)', async () => {
    const venue = new LiveVenue();
    await expect(venue.quote(buyOne)).rejects.toThrow(/refuse to invent 50/);
    expect(venue.lastLimit).toBeUndefined();
  });

  it('NaN / 0 depth refuses (no invent 50)', async () => {
    await expect(new LiveVenue(Number.NaN).quote(buyOne)).rejects.toThrow(/refuse to invent 50/);
    await expect(new LiveVenue(0).quote(buyOne)).rejects.toThrow(/refuse to invent 50/);
  });

  it('owner-explicit 50 is published (not invented)', async () => {
    const venue = new LiveVenue(50);
    const quoted = await venue.quote(buyOne);
    expect(venue.lastLimit).toBe(50);
    expect(quoted?.venueId).toBe('intachain-clob');
    expect(quoted?.amount).toBe(amt('1'));
  });
});
