import { describe, expect, it } from 'vitest';
import { fixedFundingRateSource, isRateFresh, memoryFundingRateBook, periodIdFor, preferFundingRateSource } from './funding-rate-source.js';

/** Test-only magnitude bound — NOT product law (D2). */
const FIXTURE_FUNDING_MAX_ABS = '1';
import { memoryFundingMarginApplier, memoryFundingPeriodStore, runFundingTick } from './funding-tick.js';
import { parseAmount as amt, type PostRequest } from '@intafaced/ledger-client';
import type { FundingOpenPosition } from './funding-settlement.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function longShort(): FundingOpenPosition[] {
  return [
    {
      positionId: 'plong',
      userId: A,
      side: 'long',
      size: amt('1'),
      entryPrice: amt('50000'),
      marginAsset: 'USDT',
    },
    {
      positionId: 'pshort',
      userId: B,
      side: 'short',
      size: amt('1'),
      entryPrice: amt('50000'),
      marginAsset: 'USDT',
    },
  ];
}

describe('periodIdFor', () => {
  it('names period without inventing rate', () => {
    expect(periodIdFor('m1', '2026-07-31T00:00:00.000Z')).toBe('m1:2026-07-31T00:00:00.000Z');
  });
});

describe('memoryFundingRateBook', () => {
  it('empty book → null (never invents)', async () => {
    const book = memoryFundingRateBook({ now: () => 1_000_000 });
    expect(await book.source().quote({ marketId: 'm1', at: new Date(1_000_000) })).toBeNull();
  });

  it('returns published rate when fresh', async () => {
    const book = memoryFundingRateBook({ now: () => 1_000_000 });
    book.set({
      marketId: 'm1',
      rate: '0.0001',
      periodId: periodIdFor('m1', '2026-07-31T00:00:00.000Z'),
      asOfMs: 1_000_000,
    });
    const q = await book.source({ maxAgeMs: 0 }).quote({ marketId: 'm1', at: new Date(1_000_000) });
    expect(q).toEqual({
      marketId: 'm1',
      rate: '0.0001',
      periodId: 'm1:2026-07-31T00:00:00.000Z',
    });
  });

  it('omitted maxAgeMs is missing — not an invented 8h window', async () => {
    const book = memoryFundingRateBook({ now: () => 1_000_000 });
    book.set({
      marketId: 'm1',
      rate: '0.0001',
      periodId: periodIdFor('m1', '2026-07-31T00:00:00.000Z'),
      asOfMs: 1_000_000,
    });
    expect(await book.source().quote({ marketId: 'm1', at: new Date(1_000_000) })).toBeNull();
  });

  it('stale rate → null', async () => {
    const book = memoryFundingRateBook();
    book.set({
      marketId: 'm1',
      rate: '0.0001',
      periodId: 'm1:t0',
      asOfMs: 0,
    });
    const src = book.source({ maxAgeMs: 1_000 });
    expect(await src.quote({ marketId: 'm1', at: new Date(10_000) })).toBeNull();
  });

  it('rejects empty periodId and bad rate strings', async () => {
    const book = memoryFundingRateBook({ now: () => 5_000 });
    book.set({ marketId: 'm1', rate: 'not-a-number', periodId: 'p', asOfMs: 5_000 });
    expect(await book.source().quote({ marketId: 'm1', at: new Date(5_000) })).toBeNull();
    book.set({ marketId: 'm1', rate: '0.01', periodId: '  ', asOfMs: 5_000 });
    expect(await book.source().quote({ marketId: 'm1', at: new Date(5_000) })).toBeNull();
  });

  it('allows negative rates (shorts pay)', async () => {
    const book = memoryFundingRateBook({ now: () => 5_000 });
    book.set({
      marketId: 'm1',
      rate: '-0.0001',
      periodId: 'm1:neg',
      asOfMs: 5_000,
    });
    const q = await book.source({ maxAgeMs: 0 }).quote({ marketId: 'm1', at: new Date(5_000) });
    expect(q?.rate).toBe('-0.0001');
  });
});

describe('fixedFundingRateSource', () => {
  it('null quote stays null', async () => {
    expect(await fixedFundingRateSource(null).quote({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('refuses market mismatch', async () => {
    const src = fixedFundingRateSource({ marketId: 'm1', rate: '0.01', periodId: 'p' });
    expect(await src.quote({ marketId: 'm2', at: new Date() })).toBeNull();
  });
});

describe('no invented 8h freshness default', () => {
  it('source does not pin a typical funding interval', async () => {
    // A fresh rate with no maxAgeMs named quotes nothing: there is no 8 h (or any) freshness window of its own.
    const book = memoryFundingRateBook({ now: () => 1_000_000 });
    book.set({ marketId: 'm1', rate: '0.0001', periodId: 'p1', asOfMs: 1_000_000 });
    const at = new Date(1_000_000 + 60_000);
    expect(await book.source().quote({ marketId: 'm1', at })).toBeNull();
    // Just inside and just past an 8 h window: the named policy alone decides.
    const eightHours = 8 * 60 * 60 * 1000;
    expect(await book.source({ maxAgeMs: eightHours }).quote({ marketId: 'm1', at: new Date(1_000_000 + eightHours) })).toEqual({
      rate: '0.0001',
      periodId: 'p1',
      marketId: 'm1',
    });
    expect(await book.source({ maxAgeMs: 1000 }).quote({ marketId: 'm1', at })).toBeNull();
  });

  it('no export has an 8h boundary of its own: only a named policy draws one', async () => {
    const eightHours = 8 * 60 * 60 * 1000;
    const ages = [0, 1, eightHours - 1, eightHours, eightHours + 1, 3 * eightHours];
    const entry = { marketId: 'm1', rate: '0.0001', periodId: 'p1', asOfMs: 1_000_000 };
    const quoteAt = (src: { quote(i: { marketId: string; at: Date }): Promise<unknown> }, age: number) =>
      src.quote({ marketId: 'm1', at: new Date(entry.asOfMs + age) });
    for (const age of ages) {
      // Book with no policy, on the book or on the source: nothing quotes, at any age.
      const bare = memoryFundingRateBook({ now: () => entry.asOfMs + age });
      bare.set(entry);
      expect(await quoteAt(bare.source(), age), `bare ${age}`).toBeNull();
      // A named window decides alone, on the book or on the source, at its own edge and not at 8h.
      for (const maxAgeMs of [1_000, eightHours * 2]) {
        const named = memoryFundingRateBook({ now: () => entry.asOfMs + age, policy: { maxAgeMs } });
        named.set(entry);
        const fresh = age <= maxAgeMs;
        expect(Boolean(await quoteAt(named.source(), age)), `book ${maxAgeMs} ${age}`).toBe(fresh);
        expect(Boolean(await quoteAt(bare.source({ maxAgeMs }), age)), `source ${maxAgeMs} ${age}`).toBe(fresh);
        expect(isRateFresh(entry, entry.asOfMs + age, maxAgeMs), `isRateFresh ${maxAgeMs} ${age}`).toBe(fresh);
      }
      // maxAgeMs 0 is the explicit "no age limit" choice; it never becomes 8h.
      expect(isRateFresh(entry, entry.asOfMs + age, 0)).toBe(true);
      // The fixed source and the preferring source pass a quote on unchanged, whatever its age.
      const fixed = fixedFundingRateSource({ marketId: 'm1', rate: '0.0001', periodId: 'p1' });
      expect(await quoteAt(fixed, age)).toEqual({ marketId: 'm1', rate: '0.0001', periodId: 'p1' });
      expect(await quoteAt(preferFundingRateSource(bare.source(), fixed), age)).toEqual({ marketId: 'm1', rate: '0.0001', periodId: 'p1' });
      expect(await quoteAt(preferFundingRateSource(bare.source(), fixedFundingRateSource(null)), age)).toBeNull();
    }
    expect(periodIdFor('m1', '2026-07-31T00:00:00.000Z')).toBe('m1:2026-07-31T00:00:00.000Z');
  });
});

describe('isRateFresh', () => {
  it('respects maxAgeMs', () => {
    const e = { marketId: 'm', rate: '0', periodId: 'p', asOfMs: 1000 };
    expect(isRateFresh(e, 1500, 1000)).toBe(true);
    expect(isRateFresh(e, 2500, 1000)).toBe(false);
    expect(isRateFresh(e, 99999, 0)).toBe(true);
  });
});

describe('integration: rate book → funding tick', () => {
  it('skips settle when rate book empty', async () => {
    const book = memoryFundingRateBook({ now: () => 1_000_000 });
    const posts: PostRequest[] = [];
    const result = await runFundingTick(
      {
        rates: book.source(),
        positions: {
          async listOpenForMarket() {
            return longShort();
          },
        },
        periods: memoryFundingPeriodStore(),
        margins: memoryFundingMarginApplier(),
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        ledger: {
          async post(req) {
            posts.push(req);
            return { id: 'x', idempotencyKey: req.idempotencyKey } as never;
          },
        },
        now: () => new Date(1_000_000),
      },
      'm1',
    );
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('no_rate');
      // ADR §5: skip is recorded with a queryable period id (not silent void).
      expect(result.periodId).toMatch(/^m1:no_rate:/);
    }
    expect(posts).toHaveLength(0);
  });

  it('settles when external rate published', async () => {
    const book = memoryFundingRateBook({ now: () => 1_000_000 });
    book.set({
      marketId: 'm1',
      rate: '0.0001',
      periodId: periodIdFor('m1', '2026-07-31T00:00:00.000Z'),
      asOfMs: 1_000_000,
    });
    const posts: PostRequest[] = [];
    const result = await runFundingTick(
      {
        rates: book.source({ maxAgeMs: 0 }),
        positions: {
          async listOpenForMarket() {
            return longShort();
          },
        },
        periods: memoryFundingPeriodStore(),
        margins: memoryFundingMarginApplier(),
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        ledger: {
          async post(req) {
            posts.push(req);
            return { id: 'x', idempotencyKey: req.idempotencyKey } as never;
          },
        },
        now: () => new Date(1_000_000),
      },
      'm1',
    );
    expect(result.status).toBe('settled');
    expect(posts.length).toBeGreaterThan(0);
  });
});
