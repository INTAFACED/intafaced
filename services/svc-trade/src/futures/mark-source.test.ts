import { describe, expect, it } from 'vitest';
import { markSourceFromBook, memoryMarkBook, midFromBook, toQuotedMark } from './mark-source.js';
import { runLiquidationTick, memoryLiquidationAttemptStore } from './liquidation-tick.js';
import { deepFullCloseLadder } from './ladder-policy.test-harness.js';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { DEFAULT_FUTURES_MARK_POLICY, type MarkPolicy } from './mark-policy.js';
import { parseAmount as amt, formatAmount, type PostRequest } from '@intafaced/ledger-client';

/** Policy helper — spelled in the `prices.ts` four-field shape, never in ms. */
function policy(overrides: Partial<MarkPolicy> = {}): MarkPolicy {
  return { ...DEFAULT_FUTURES_MARK_POLICY, ...overrides };
}

describe('midFromBook', () => {
  it('returns mid of two-sided book', () => {
    expect(midFromBook('100', '102')).toBe('101');
  });

  it('returns null when a side is missing', () => {
    expect(midFromBook('100', null)).toBeNull();
    expect(midFromBook(null, '102')).toBeNull();
    expect(midFromBook('', '102')).toBeNull();
  });

  it('returns null when ask < bid (crossed)', () => {
    expect(midFromBook('102', '100')).toBeNull();
  });
});

describe('toQuotedMark', () => {
  it('parses a decimal feed value into a scaled bigint quote', () => {
    const q = toQuotedMark({ marketId: 'm1', price: '50000', quality: 'index', asOfMs: 1_000 });
    expect(q).not.toBeNull();
    expect(q!.price).toBe(amt('50000'));
    expect(q!.asOf.getTime()).toBe(1_000);
    expect(q!.quality).toBe('index');
  });

  it('refuses a zero or malformed feed value — a broken feed is not a cheap market', () => {
    expect(toQuotedMark({ marketId: 'm1', price: '0', quality: 'mid', asOfMs: 1 })).toBeNull();
    expect(toQuotedMark({ marketId: 'm1', price: '-5', quality: 'mid', asOfMs: 1 })).toBeNull();
    expect(toQuotedMark({ marketId: 'm1', price: 'abc', quality: 'mid', asOfMs: 1 })).toBeNull();
  });
});

describe('memoryMarkBook', () => {
  it('returns null when empty (never invents)', async () => {
    const book = memoryMarkBook();
    const src = book.source();
    expect(await src.markPrice({ marketId: 'm1', at: new Date(1_000_000) })).toBeNull();
    expect(await src.quote({ marketId: 'm1', at: new Date(1_000_000) })).toBeNull();
  });

  it('returns set mark when fresh and quality allowed', async () => {
    const book = memoryMarkBook();
    book.set({ marketId: 'm1', price: '50000', quality: 'index', asOfMs: 1_000_000 });
    const src = book.source(policy({ liquidationMaxAgeSeconds: 60 }));
    expect(await src.markPrice({ marketId: 'm1', at: new Date(1_030_000) })).toBe('50000');
  });

  it('stale mark → null', async () => {
    const book = memoryMarkBook();
    book.set({ marketId: 'm1', price: '50000', quality: 'mid', asOfMs: 0 });
    const src = book.source(policy({ liquidationMaxAgeSeconds: 1 }));
    expect(await src.markPrice({ marketId: 'm1', at: new Date(10_000) })).toBeNull();
  });

  it('refuses last quality for liquidation by default', async () => {
    const book = memoryMarkBook();
    book.set({ marketId: 'm1', price: '50000', quality: 'last', asOfMs: 5_000 });
    const src = book.source();
    expect(await src.markPrice({ marketId: 'm1', at: new Date(5_000) })).toBeNull();
  });

  it('still HANDS BACK the last-quality quote — refusing to liquidate on it is the gate, not the feed', async () => {
    const book = memoryMarkBook();
    book.set({ marketId: 'm1', price: '50000', quality: 'last', asOfMs: 5_000 });
    const quoted = await book.source().quote({ marketId: 'm1', at: new Date(5_000) });
    expect(quoted?.quality).toBe('last');
    expect(quoted?.price).toBe(amt('50000'));
  });

  it('allows last when policy opts in', async () => {
    const book = memoryMarkBook();
    book.set({ marketId: 'm1', price: '50000', quality: 'last', asOfMs: 5_000 });
    const src = book.source(policy({ liquidationQualities: ['last', 'mid', 'index'] }));
    expect(await src.markPrice({ marketId: 'm1', at: new Date(5_000) })).toBe('50000');
  });
});

describe('markSourceFromBook', () => {
  const at = new Date('2026-08-06T12:00:00.000Z');

  it('uses mid when two-sided', async () => {
    const src = markSourceFromBook({
      async readBook() {
        return { bestBid: '99', bestAsk: '101', last: '50', observedAt: at };
      },
    });
    expect(await src.markPrice({ marketId: 'm1', at })).toBe('100');
    expect((await src.quote({ marketId: 'm1', at }))?.quality).toBe('mid');
  });

  it('empty book → null', async () => {
    const src = markSourceFromBook({
      async readBook() {
        return { bestBid: null, bestAsk: null, last: null };
      },
    });
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('labels the last print `last` and refuses it as a price unless policy allows', async () => {
    const src = markSourceFromBook({
      async readBook() {
        return { bestBid: null, bestAsk: null, last: '77', observedAt: at };
      },
    });
    expect((await src.quote({ marketId: 'm1', at }))?.quality).toBe('last');
    expect(await src.markPrice({ marketId: 'm1', at })).toBeNull();

    const srcLast = markSourceFromBook({
      async readBook() {
        return { bestBid: null, bestAsk: null, last: '77', observedAt: at };
      },
      policy: policy({ liquidationQualities: ['last'] }),
    });
    expect(await srcLast.markPrice({ marketId: 'm1', at })).toBe('77');
  });
});

describe('integration: mark book → liquidation tick', () => {
  const USER = '11111111-1111-4111-8111-111111111111';

  function position() {
    return {
      positionId: 'pos-1',
      userId: USER,
      side: 'long' as const,
      size: amt('1'),
      entryPrice: amt('100'),
      margin: amt('10'),
      marginAsset: 'USDT',
      marketId: 'm1',
    };
  }

  function tickDeps(marks: Parameters<typeof runLiquidationTick>[0]['marks'], posts: PostRequest[], closed: string[]) {
    return {
      marks,
      positions: {
        async listOpen() {
          return [position()];
        },
      },
      closer: {
        async markLiquidated(id: string) {
          closed.push(id);
        },
      },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger: {
        async post(req: PostRequest) {
          posts.push(req);
          return { id: 'x', idempotencyKey: req.idempotencyKey } as never;
        },
        async balance() {
          // Funded enough for any shortfall in this suite's underwater fixture.
          return {
            account: { ownerType: 'house' as const, ownerId: 'insurance-fund', assetId: 'USDT', kind: 'available' as const },
            accountId: 'x',
            amount: 10n ** 30n,
          };
        },
      },
      now: () => new Date(1_000_000),
      liquidationIdFor: () => 'liq-1',
      ladder: deepFullCloseLadder(),
    };
  }

  it('does not liquidate when mark book empty', async () => {
    const posts: PostRequest[] = [];
    const closed: string[] = [];
    const result = await runLiquidationTick(tickDeps(memoryMarkBook().source(), posts, closed));
    expect(result.liquidated).toBe(0);
    expect(result.items[0]!.outcome).toBe('skipped_no_mark');
    expect(posts).toHaveLength(0);
    expect(closed).toEqual([]);
  });

  it('liquidates when index mark is underwater', async () => {
    const book = memoryMarkBook();
    book.set({ marketId: 'm1', price: '80', quality: 'index', asOfMs: 1_000_000 });
    const posts: PostRequest[] = [];
    const closed: string[] = [];
    const result = await runLiquidationTick(tickDeps(book.source(), posts, closed));
    expect(result.liquidated).toBe(1);
    expect(closed).toEqual(['pos-1']);
    expect(posts.length).toBeGreaterThan(0);
  });

  it('formats the gated quote back to the same decimal string the planner used', async () => {
    const book = memoryMarkBook();
    book.set({ marketId: 'm1', price: '80.5', quality: 'mid', asOfMs: 1_000_000 });
    const quoted = await book.source().quote({ marketId: 'm1', at: new Date(1_000_000) });
    expect(formatAmount(quoted!.price)).toBe('80.5');
  });
});
