/**
 * Unit card — sourceQuote refuse when DEX_QUOTE_DEPTH unpublished
 *
 * 1. Promise: omitted / 0 / NaN depth → dex.quote.depth_unset (no invented 50).
 *    Owner-explicit 50 is a published number, not a git default.
 * 2. Break: sourceQuote treating missing depth as 50 lets blank look published.
 * 3. Done bar: sourceQuote refuses before any venue fetch; source has no default 50.
 * 4. Class M
 * 5. Paths: quote-service.ts sourceQuote
 * 6. RED: unset quote succeeds or source git-defaults 50
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

  constructor() {
    super({ quoteTtlMs: 2_000 });
  }

  protected async fetchDepth(symbol: string): Promise<TimestampedBook> {
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

describe('sourceQuote depth unpublished', () => {
  it('unset depth refuses (does not invent 50)', async () => {
    await expect(sourceQuote({ venues: [new LiveVenue()], maxAgeMs: 2_000, now: () => NOW }, buyOne)).rejects.toMatchObject({
      name: 'QuoteRefusedError',
      code: 'dex.quote.depth_unset',
    } satisfies Partial<QuoteRefusedError>);
  });

  it('NaN / 0 depth refuses (does not invent 50)', async () => {
    await expect(
      sourceQuote({ venues: [new LiveVenue()], maxAgeMs: 2_000, depth: Number.NaN, now: () => NOW }, buyOne),
    ).rejects.toMatchObject({ code: 'dex.quote.depth_unset' });
    await expect(sourceQuote({ venues: [new LiveVenue()], maxAgeMs: 2_000, depth: 0, now: () => NOW }, buyOne)).rejects.toMatchObject({
      code: 'dex.quote.depth_unset',
    });
  });

  it('owner-explicit 50 quotes', async () => {
    const quoted = await sourceQuote({ venues: [new LiveVenue()], maxAgeMs: 2_000, depth: 50, now: () => NOW }, buyOne);
    expect(quoted.route.filledQty).toBe('1');
  });
});
