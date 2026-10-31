import { describe, expect, it } from 'vitest';
import {
  outcomeMarketDetailSchema,
  outcomeMarketDraftInputSchema,
  outcomeMarketListQuerySchema,
  outcomeMarketMoveInputSchema,
  outcomeMarketSummarySchema,
} from './outcome-markets.js';

const market = (over: Record<string, unknown> = {}) => ({
  id: 'test-rain-friday',
  kind: 'outcome',
  question: 'TEST: does it rain on Friday?',
  category: 'weather',
  tags: ['test'],
  closeMode: 'at_time',
  closeAt: '2027-01-01T00:00:00Z',
  settlementAssetId: 'USDT',
  settlementSource: 'TEST source',
  status: 'open',
  collateralization: 'full',
  instruments: [
    { outcome: 'yes', symbol: 'test-rain-friday:YES' },
    { outcome: 'no', symbol: 'test-rain-friday:NO' },
  ],
  lastPrice: null,
  tradeCount: 0,
  publishedAt: '2026-10-31T00:00:00Z',
  ...over,
});

describe('outcome markets wire (MC-predict-01)', () => {
  it('reads a market, and an on_outcome market carries no close time', () => {
    expect(outcomeMarketSummarySchema.safeParse(market()).success).toBe(true);
    expect(outcomeMarketSummarySchema.safeParse(market({ closeMode: 'on_outcome', closeAt: null })).success).toBe(true);
    expect(outcomeMarketSummarySchema.safeParse(market({ closeMode: 'on_outcome' })).success).toBe(false);
    expect(outcomeMarketSummarySchema.safeParse(market({ closeAt: null })).success).toBe(false);
  });

  it('takes a price only as a decimal string, and none when the book has no trade', () => {
    expect(outcomeMarketSummarySchema.safeParse(market({ lastPrice: '0.62' })).success).toBe(true);
    expect(outcomeMarketSummarySchema.safeParse(market({ lastPrice: 0.62 })).success).toBe(false);
  });

  it('lets only a draft lack its source, publish time or rules', () => {
    expect(outcomeMarketSummarySchema.safeParse(market({ settlementSource: null })).success).toBe(false);
    expect(outcomeMarketSummarySchema.safeParse(market({ publishedAt: null })).success).toBe(false);
    expect(outcomeMarketSummarySchema.safeParse(market({ status: 'draft', settlementSource: null, publishedAt: null })).success).toBe(true);
    const detail = (status: string, rulesText: string | null) => ({
      market: market({ status }),
      rulesText,
      rulesVersion: 1,
      timeline: [],
      clarifications: [],
    });
    expect(outcomeMarketDetailSchema.safeParse(detail('open', null)).success).toBe(false);
    expect(outcomeMarketDetailSchema.safeParse(detail('open', 'TEST rules')).success).toBe(true);
  });

  it("refuses instruments that are not the market's own Yes and No", () => {
    const wrong = [
      { outcome: 'yes', symbol: 'other:YES' },
      { outcome: 'no', symbol: 'test-rain-friday:NO' },
    ];
    expect(outcomeMarketSummarySchema.safeParse(market({ instruments: wrong })).success).toBe(false);
  });

  it('keeps reserved route segments out of market ids', () => {
    for (const id of ['positions', 'settings', 'Has Space', ''])
      expect(outcomeMarketSummarySchema.safeParse(market({ id })).success).toBe(false);
  });

  it('needs a limit on the list, never lists drafts and takes only the known sorts', () => {
    expect(outcomeMarketListQuerySchema.safeParse({ limit: '20', sort: 'trending', category: 'weather' }).success).toBe(true);
    expect(outcomeMarketListQuerySchema.safeParse({ sort: 'trending' }).success).toBe(false);
    expect(outcomeMarketListQuerySchema.safeParse({ limit: 20, status: 'draft' }).success).toBe(false);
    expect(outcomeMarketListQuerySchema.safeParse({ limit: 20, sort: 'returns' }).success).toBe(false);
    for (const limit of ['0x14', '1e1', true, '0', 0, -1])
      expect(outcomeMarketListQuerySchema.safeParse({ limit }).success, String(limit)).toBe(false);
    expect(outcomeMarketListQuerySchema.parse({ limit: '20', cursor: 'abc' })).toMatchObject({ limit: 20, cursor: 'abc' });
  });

  it('carries the rules, the timeline and the clarifications, with unset rules as null', () => {
    const detail = {
      market: market({ status: 'draft', publishedAt: null }),
      rulesText: null,
      rulesVersion: 0,
      timeline: [{ ordinal: 1, move: 'created', at: '2026-10-30T00:00:00Z', actorId: 'founder-a' }],
      clarifications: [],
    };
    expect(outcomeMarketDetailSchema.safeParse(detail).success).toBe(true);
  });

  it('takes a draft with blanks left blank, and a move with the ordinal read', () => {
    const draft = {
      id: 'test-rain-friday',
      question: 'TEST: does it rain on Friday?',
      category: null,
      tags: [],
      closeMode: 'on_outcome',
      closeAt: null,
      settlementAssetId: 'USDT',
      settlementSource: null,
      rulesText: null,
    };
    expect(outcomeMarketDraftInputSchema.safeParse(draft).success).toBe(true);
    expect(outcomeMarketDraftInputSchema.safeParse({ ...draft, extra: 1 }).success).toBe(false);
    expect(outcomeMarketMoveInputSchema.safeParse({ marketId: 'test-rain-friday', move: 'published', expectedOrdinal: 1 }).success).toBe(
      true,
    );
    expect(outcomeMarketMoveInputSchema.safeParse({ marketId: 'test-rain-friday', move: 'determined', expectedOrdinal: 1 }).success).toBe(
      false,
    );
  });
});
