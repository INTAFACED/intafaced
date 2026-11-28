/**
 * Unit card — sourceQuote refuse when QUOTE_MAX_AGE_MS unpublished
 *
 * 1. Promise: omitted / 0 / NaN / 99 maxAgeMs → dex.quote.max_age_unset
 *    (no invented 2000). Owner-explicit 2000 is a published number, not a git default.
 * 2. Break: sourceQuote treating missing maxAgeMs as 2000 lets blank look published.
 * 3. Done bar: sourceQuote refuses before any venue fetch; source has no default 2000.
 * 4. Class M
 * 5. Paths: quote-service.ts sourceQuote
 * 6. RED: unset quote succeeds or source git-defaults 2000
 */
import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client/money';
import { QuoteRefusedError, sourceQuote } from './quote-service.js';
import { MarketDataSource } from './market-data-source.js';
import type { TimestampedBook } from './venue.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

class LiveVenue extends MarketDataSource {
  readonly id = 'intachain-clob';
  readonly kind = 'external-dex' as const;
  readonly feeBps = 0;
  readonly settlementCost = 0n;
  fetched = false;

  constructor() {
    super({ quoteTtlMs: 2_000 });
  }

  protected async fetchDepth(symbol: string): Promise<TimestampedBook> {
    this.fetched = true;
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

const buyOne = { symbol: 'IFC-USD', side: 'buy' as const, qty: amt('1') };

describe('sourceQuote max age unpublished', () => {
  it('unset maxAgeMs refuses (does not invent 2000) and does not fetch', async () => {
    const venue = new LiveVenue();
    await expect(sourceQuote({ venues: [venue], depth: 50, now: () => NOW }, buyOne)).rejects.toMatchObject({
      name: 'QuoteRefusedError',
      code: 'dex.quote.max_age_unset',
    } satisfies Partial<QuoteRefusedError>);
    expect(venue.fetched).toBe(false);
  });

  it('NaN / 0 / 99 maxAgeMs refuses (does not invent 2000)', async () => {
    await expect(sourceQuote({ venues: [new LiveVenue()], depth: 50, maxAgeMs: Number.NaN, now: () => NOW }, buyOne)).rejects.toMatchObject(
      { code: 'dex.quote.max_age_unset' },
    );
    await expect(sourceQuote({ venues: [new LiveVenue()], depth: 50, maxAgeMs: 0, now: () => NOW }, buyOne)).rejects.toMatchObject({
      code: 'dex.quote.max_age_unset',
    });
    await expect(sourceQuote({ venues: [new LiveVenue()], depth: 50, maxAgeMs: 99, now: () => NOW }, buyOne)).rejects.toMatchObject({
      code: 'dex.quote.max_age_unset',
    });
  });

  it('owner-explicit 2000 quotes', async () => {
    const quoted = await sourceQuote({ venues: [new LiveVenue()], depth: 50, maxAgeMs: 2_000, now: () => NOW }, buyOne);
    expect(quoted.route.filledQty).toBe('1');
    expect(quoted.maxAgeMs).toBe(2_000);
  });
});
