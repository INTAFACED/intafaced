import { describe, expect, it, vi } from 'vitest';
import { parseAmount as amt, type PostRequest } from '@intafaced/ledger-client';
import {
  memoryFundingMarginApplier,
  memoryFundingPeriodStore,
  runFundingTick,
  type FundingRateSource,
  type FundingPositionLoader,
} from './funding-tick.js';
import type { FundingOpenPosition } from './funding-settlement.js';

/** Test-only magnitude bound — NOT product law (owner residual D2). */
const FIXTURE_FUNDING_MAX_ABS = '1';

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

function fixedRate(rate: string, periodId = 'm1:2026-07-31T00:00:00Z'): FundingRateSource {
  return {
    async quote({ marketId }) {
      return { rate, periodId, marketId };
    },
  };
}

function positionsOf(rows: FundingOpenPosition[]): FundingPositionLoader {
  return {
    async listOpenForMarket() {
      return rows;
    },
  };
}

function recordingLedger() {
  const posts: PostRequest[] = [];
  return {
    posts,
    ledger: {
      async post(req: PostRequest) {
        posts.push(req);
        return { id: `tx-${posts.length}`, idempotencyKey: req.idempotencyKey } as never;
      },
    },
  };
}

describe('runFundingTick', () => {
  it('skips when rate source returns null (never invents)', async () => {
    const rates: FundingRateSource = {
      async quote() {
        return null;
      },
    };
    const { ledger, posts } = recordingLedger();
    const result = await runFundingTick(
      {
        rates,
        positions: positionsOf(longShort()),
        periods: memoryFundingPeriodStore(),
        margins: memoryFundingMarginApplier(),
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        ledger,
      },
      'm1',
    );
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('no_rate');
      expect(result.periodId).toMatch(/^m1:no_rate:/);
    }
    expect(posts).toHaveLength(0);
  });

  it('skips when no open positions', async () => {
    const { ledger, posts } = recordingLedger();
    const result = await runFundingTick(
      {
        rates: fixedRate('0.0001'),
        positions: positionsOf([]),
        periods: memoryFundingPeriodStore(),
        margins: memoryFundingMarginApplier(),
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        ledger,
      },
      'm1',
    );
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') expect(result.reason).toBe('no_positions');
    expect(posts).toHaveLength(0);
  });

  it('posts funding legs for long/short book and marks period settled', async () => {
    const periods = memoryFundingPeriodStore();
    const { ledger, posts } = recordingLedger();
    const result = await runFundingTick(
      {
        rates: fixedRate('0.0001', 'm1:period-1'),
        positions: positionsOf(longShort()),
        periods,
        margins: memoryFundingMarginApplier(),
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        ledger,
      },
      'm1',
    );
    expect(result.status).toBe('settled');
    if (result.status === 'settled') {
      expect(result.periodId).toBe('m1:period-1');
      expect(result.legCount).toBe(1);
      expect(result.summary).toContain('1 leg');
    }
    expect(posts).toHaveLength(1);
    expect(posts[0]!.reason).toBe('futures.funding.paid');
    expect(await periods.isSettled('m1:period-1')).toBe(true);
  });

  it('second tick same period is already_settled (no double post)', async () => {
    const periods = memoryFundingPeriodStore();
    const { ledger, posts } = recordingLedger();
    const deps = {
      rates: fixedRate('0.0001', 'm1:period-2'),
      positions: positionsOf(longShort()),
      periods,
      margins: memoryFundingMarginApplier(),
      maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
      ledger,
    };
    await runFundingTick(deps, 'm1');
    const second = await runFundingTick(deps, 'm1');
    expect(second).toEqual({ status: 'skipped', reason: 'already_settled', periodId: 'm1:period-2' });
    expect(posts).toHaveLength(1);
  });

  /**
   * The third funding double-charge — a replay whose BOOK has changed.
   *
   * Every other test here replays against a fixed array, so none of them can
   * see this: the tick posts legs before it writes the settle marker, and if it
   * dies in that gap the retry re-plans against whatever the book is by then. A
   * short closing in between needs no job enabled — it is a plain
   * `DELETE /api/v1/positions/:id`.
   *
   * With `:${seq}` in the funding id, the surviving pair was renumbered on the
   * replay, reached the ledger under a key it had never seen, and posted a
   * second time. The ledger below dedupes the way the real one does, so if the
   * key stops being stable this test fails on the payer's total.
   */
  /**
   * C14 — a position OPENED between a crashed post and its replay must not
   * charge the original payer again.
   *
   * Without freezeMembership the replay re-plans open-now, the new short
   * creates a fresh (period, payer, payee) key, and the ledger posts an extra
   * leg while applyFundingNets has already claimed the original payer for the
   * period. Ledger > margin_current for the payer.
   */
  it('a position opened after the first plan for a period is not charged on replay', async () => {
    const long = {
      positionId: 'plong',
      userId: A,
      side: 'long' as const,
      size: amt('1'),
      entryPrice: amt('50000'),
      marginAsset: 'USDT',
    };
    const shortX = { ...long, positionId: 'pshortX', userId: B, side: 'short' as const };
    const shortNew = { ...long, positionId: 'pshortNew', userId: B, side: 'short' as const };

    const seen = new Map<string, PostRequest>();
    const attempts: PostRequest[] = [];
    const ledger = {
      async post(req: PostRequest) {
        attempts.push(req);
        if (!seen.has(req.idempotencyKey)) seen.set(req.idempotencyKey, req);
        return { id: req.idempotencyKey, idempotencyKey: req.idempotencyKey } as never;
      },
    };
    // Real freeze store; settle marker always crashes (post→settle gap).
    const basePeriods = memoryFundingPeriodStore();
    const periods = {
      ...basePeriods,
      async isSettled() {
        return false;
      },
      async markSettled() {
        throw new Error('crashed before the settle marker was written');
      },
    };
    const margins = memoryFundingMarginApplier();
    const rates = fixedRate('0.0001', 'm1:period-membership-open');

    // Attempt 1: book is long + shortX. Posts, then crashes on settle.
    await expect(
      runFundingTick(
        { rates, positions: positionsOf([long, shortX]), periods, margins, ledger, maxAbsRate: FIXTURE_FUNDING_MAX_ABS },
        'm1',
      ),
    ).rejects.toThrow(/crashed/);
    expect(seen.size).toBe(1);
    const afterFirstKeys = new Set(seen.keys());
    const onePeriod = (amt('0.0001') * ((amt('1') * amt('50000')) / 10n ** 18n)) / 10n ** 18n;
    expect(margins.paidByPosition('plong')).toBe(onePeriod);

    // New short opens. Replay must NOT mint a second leg for plong.
    await expect(
      runFundingTick(
        { rates, positions: positionsOf([long, shortX, shortNew]), periods, margins, ledger, maxAbsRate: FIXTURE_FUNDING_MAX_ABS },
        'm1',
      ),
    ).rejects.toThrow(/crashed/);

    const newKeys = [...seen.keys()].filter((k) => !afterFirstKeys.has(k));
    expect(newKeys).toEqual([]);
    expect(seen.size).toBe(1);

    // Original payer charged once on ledger and once on margin.
    const charged = [...seen.values()]
      .filter((req) => (req.meta as { payerPositionId?: string }).payerPositionId === 'plong')
      .reduce((a, req) => a + (req.entries[0]!.amount as bigint), 0n);
    expect(charged).toBe(onePeriod);
    expect(margins.paidByPosition('plong')).toBe(onePeriod);
    expect(margins.paidByPosition('pshortNew')).toBe(0n);
    expect(attempts.length).toBeGreaterThan(seen.size);
  });

  it('freezeMembership is first-writer: a second open set cannot widen the plan', async () => {
    const periods = memoryFundingPeriodStore();
    const a = longShort()[0]!;
    const b = longShort()[1]!;
    const c = { ...b, positionId: 'pshort2' };
    const first = await periods.freezeMembership('m1:p', [a, b]);
    const second = await periods.freezeMembership('m1:p', [a, b, c]);
    expect(first.map((p) => p.positionId)).toEqual(['plong', 'pshort']);
    expect(second.map((p) => p.positionId)).toEqual(['plong', 'pshort']);
  });

  /**
   * W8 residual — ids were frozen (C14) but size was live at plan time.
   *
   * Crash after ledger post, before margin apply, then shrink the long: without
   * size freeze the replay re-plans a smaller net, margin claim records the
   * small amount, ledger still holds the large post → divergence.
   */
  it('a size change between post and apply does not re-size the charge', async () => {
    const long = {
      positionId: 'plong',
      userId: A,
      side: 'long' as const,
      size: amt('2'),
      entryPrice: amt('50000'),
      marginAsset: 'USDT',
    };
    const short = {
      positionId: 'pshort',
      userId: B,
      side: 'short' as const,
      size: amt('2'),
      entryPrice: amt('50000'),
      marginAsset: 'USDT',
    };

    const seen = new Map<string, PostRequest>();
    const ledger = {
      async post(req: PostRequest) {
        if (!seen.has(req.idempotencyKey)) seen.set(req.idempotencyKey, req);
        return { id: req.idempotencyKey, idempotencyKey: req.idempotencyKey } as never;
      },
    };

    let applyCalls = 0;
    const baseMargins = memoryFundingMarginApplier();
    const margins = {
      ...baseMargins,
      async applyFundingNets(nets: Parameters<typeof baseMargins.applyFundingNets>[0], periodId: string) {
        applyCalls += 1;
        if (applyCalls === 1) {
          throw new Error('crashed after post, before margin apply');
        }
        return baseMargins.applyFundingNets(nets, periodId);
      },
      paidByPosition: (id: string) => baseMargins.paidByPosition(id),
      applied: () => baseMargins.applied(),
    };

    const periods = memoryFundingPeriodStore();
    const rates = fixedRate('0.0001', 'm1:period-size-freeze');
    const fullPeriod = (amt('0.0001') * ((amt('2') * amt('50000')) / 10n ** 18n)) / 10n ** 18n;

    // Attempt 1: size 2×2 posts, crashes before margin.
    await expect(
      runFundingTick(
        {
          rates,
          positions: positionsOf([long, short]),
          periods,
          margins,
          ledger,
          maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        },
        'm1',
      ),
    ).rejects.toThrow(/crashed after post/);

    const ledgerCharge = [...seen.values()]
      .filter((req) => (req.meta as { payerPositionId?: string }).payerPositionId === 'plong')
      .reduce((a, req) => a + (req.entries[0]!.amount as bigint), 0n);
    expect(ledgerCharge).toBe(fullPeriod);

    // Live book shrinks the long to size 1. Replay must still charge fullPeriod.
    const longShrunk = { ...long, size: amt('1') };
    const result = await runFundingTick(
      {
        rates,
        positions: positionsOf([longShrunk, short]),
        periods,
        margins,
        ledger,
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
      },
      'm1',
    );
    expect(result.status).toBe('settled');
    expect(margins.paidByPosition('plong')).toBe(fullPeriod);
    expect(margins.paidByPosition('pshort')).toBe(-fullPeriod);
  });

  it('replaying a crashed tick against a CHANGED book charges no one twice', async () => {
    const long = {
      positionId: 'plong',
      userId: A,
      side: 'long' as const,
      size: amt('2'),
      entryPrice: amt('50000'),
      marginAsset: 'USDT',
    };
    const shortX = { ...long, positionId: 'pshortX', userId: B, side: 'short' as const, size: amt('1') };
    const shortY = { ...long, positionId: 'pshortY', userId: B, side: 'short' as const, size: amt('1') };

    // A ledger that dedupes on idempotencyKey, as PostgresLedger does.
    const seen = new Map<string, PostRequest>();
    const attempts: PostRequest[] = [];
    const ledger = {
      async post(req: PostRequest) {
        attempts.push(req);
        if (!seen.has(req.idempotencyKey)) seen.set(req.idempotencyKey, req);
        return { id: req.idempotencyKey, idempotencyKey: req.idempotencyKey } as never;
      },
    };

    // A period store that never records the settle — the crash gap.
    const neverSettles = {
      ...memoryFundingPeriodStore(),
      async isSettled() {
        return false;
      },
      async markSettled() {
        throw new Error('crashed before the settle marker was written');
      },
    };
    const margins = memoryFundingMarginApplier();
    const rates = fixedRate('0.0001', 'm1:period-crash');

    // Attempt 1: full book, dies writing the marker — after the legs posted.
    await expect(
      runFundingTick(
        {
          rates,
          positions: positionsOf([long, shortX, shortY]),
          periods: neverSettles,
          margins,
          ledger,
          maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        },
        'm1',
      ),
    ).rejects.toThrow(/crashed/);
    const afterFirst = new Set(seen.keys());
    expect(afterFirst.size).toBe(2); // long→X and long→Y

    // Short X closes. Attempt 2 re-plans against the book that is left.
    await expect(
      runFundingTick(
        { rates, positions: positionsOf([long, shortY]), periods: neverSettles, margins, ledger, maxAbsRate: FIXTURE_FUNDING_MAX_ABS },
        'm1',
      ),
    ).rejects.toThrow(/crashed/);

    // The replay must not have invented a key the ledger had not already seen.
    const newKeys = [...seen.keys()].filter((k) => !afterFirst.has(k));
    expect(newKeys).toEqual([]);

    // And the money: the long is charged for one period, not two. Sum what the
    // ledger actually kept, not what the tick tried to post.
    const charged = [...seen.values()]
      .filter((req) => (req.meta as { payerPositionId?: string }).payerPositionId === 'plong')
      .reduce((a, req) => a + (req.entries[0]!.amount as bigint), 0n);
    // |rate| × matchable notional, matchable = min(long 2×50000, shorts 2×50000).
    const oneFullPeriod = (amt('0.0001') * ((amt('2') * amt('50000')) / 10n ** 18n)) / 10n ** 18n;
    expect(charged).toBe(oneFullPeriod);

    // And the OTHER half of the defect class: #1034 and #1047 were both about
    // the ledger and `margin_current` disagreeing. Asserting only the ledger
    // watches one side of the divergence.
    expect(margins.paidByPosition('plong')).toBe(oneFullPeriod);
    expect(margins.paidByPosition('pshortX') + margins.paidByPosition('pshortY')).toBe(-oneFullPeriod);

    // The tick genuinely tried again — this is a replay, not a no-op.
    expect(attempts.length).toBeGreaterThan(seen.size);
  });

  it('freezeRate is first-writer: a second rate for the same period is ignored', async () => {
    const periods = memoryFundingPeriodStore();
    expect(await periods.freezeRate('m1:p', '0.0001')).toBe('0.0001');
    expect(await periods.freezeRate('m1:p', '0.0003')).toBe('0.0001');
    expect(await periods.freezeRate('m1:other', '0.0003')).toBe('0.0003');
  });

  /**
   * Rate was the one plan input NOT frozen with the period. Legs 1..k post at
   * r1, the run dies before the settle marker, the oracle republishes the same
   * periodId at r2: leg 1 would re-post under the same key with another amount
   * (ledger.idempotency_conflict once the ledger refuses it, so the period never
   * settles and applyFundingNets never runs).
   */
  it('a retry after the oracle republishes the period at a new rate re-posts every leg at the FROZEN rate', async () => {
    const long = {
      positionId: 'plong',
      userId: A,
      side: 'long' as const,
      size: amt('2'),
      entryPrice: amt('50000'),
      marginAsset: 'USDT',
    };
    const shortX = { ...long, positionId: 'pshortX', userId: B, side: 'short' as const, size: amt('1') };
    const shortY = { ...long, positionId: 'pshortY', userId: B, side: 'short' as const, size: amt('1') };
    const book = positionsOf([long, shortX, shortY]);

    // Run 1: the 2nd ledger.post throws once, after leg 1 landed.
    const run1: PostRequest[] = [];
    let calls = 0;
    const flaky = {
      async post(req: PostRequest) {
        run1.push(req);
        calls += 1;
        if (calls === 2) throw new Error('ledger 503');
        return { id: req.idempotencyKey, idempotencyKey: req.idempotencyKey } as never;
      },
    };
    const periods = memoryFundingPeriodStore();
    const markSettled = vi.spyOn(periods, 'markSettled');
    const margins = memoryFundingMarginApplier();
    const applyFundingNets = vi.spyOn(margins, 'applyFundingNets');
    const periodId = 'm1:period-rate-republish';

    await expect(
      runFundingTick(
        { rates: fixedRate('0.0001', periodId), positions: book, periods, margins, ledger: flaky, maxAbsRate: FIXTURE_FUNDING_MAX_ABS },
        'm1',
      ),
    ).rejects.toThrow(/ledger 503/);
    expect(run1).toHaveLength(2);
    expect(markSettled).not.toHaveBeenCalled();
    expect(applyFundingNets).not.toHaveBeenCalled();

    // Run 2: oracle now quotes the SAME period at 0.0003.
    const run2 = recordingLedger();
    const result = await runFundingTick(
      { rates: fixedRate('0.0003', periodId), positions: book, periods, margins, ledger: run2.ledger, maxAbsRate: FIXTURE_FUNDING_MAX_ABS },
      'm1',
    );

    // Every leg posted in both runs is byte-identical (same key, same amount).
    expect(run2.posts).toHaveLength(2);
    expect(run2.posts[0]).toEqual(run1[0]);
    expect(run2.posts[1]).toEqual(run1[1]);
    const frozenAmount = (amt('0.0001') * ((amt('1') * amt('50000')) / 10n ** 18n)) / 10n ** 18n;
    expect(run2.posts[0]!.entries[0]!.amount).toBe(frozenAmount);

    expect(result.status).toBe('settled');
    if (result.status === 'settled') expect(result.rate).toBe('0.0001');
    expect(applyFundingNets).toHaveBeenCalledTimes(1);
    expect(markSettled).toHaveBeenCalledTimes(1);
    expect(margins.paidByPosition('plong')).toBe(frozenAmount * 2n);
  });

  it('an over-bound first quote is refused and NOT frozen: the corrected quote settles', async () => {
    const periods = memoryFundingPeriodStore();
    const periodId = 'm1:period-over-bound-then-corrected';
    const { ledger, posts } = recordingLedger();
    const margins = memoryFundingMarginApplier();
    const deps = (rate: string) => ({
      rates: fixedRate(rate, periodId),
      positions: positionsOf(longShort()),
      periods,
      margins,
      ledger,
      maxAbsRate: '0.001',
    });

    await expect(runFundingTick(deps('0.5'), 'm1')).rejects.toMatchObject({ code: 'trade.funding_rate_exceeds_max' });
    expect(posts).toHaveLength(0);
    expect(await periods.freezeRate(periodId, '0.00001')).toBe('0.00001'); // nothing was frozen by the refusal
    const settled = await runFundingTick(deps('0.00001'), 'm1');
    expect(settled.status).toBe('settled');
    expect(posts.length).toBeGreaterThan(0);
  });

  it('the bound still applies to the frozen rate (a store that froze a larger one earlier)', async () => {
    const periods = memoryFundingPeriodStore();
    const periodId = 'm1:period-frozen-over-bound';
    await periods.freezeRate(periodId, '0.5'); // e.g. frozen before the bound was configured
    const { ledger, posts } = recordingLedger();
    await expect(
      runFundingTick(
        {
          rates: fixedRate('0.00001', periodId),
          positions: positionsOf(longShort()),
          periods,
          margins: memoryFundingMarginApplier(),
          ledger,
          maxAbsRate: '0.001',
        },
        'm1',
      ),
    ).rejects.toMatchObject({ code: 'trade.funding_rate_exceeds_max' });
    expect(posts).toHaveLength(0);
  });

  it('zero rate: no legs, marks settled so cron does not invent retry money', async () => {
    const periods = memoryFundingPeriodStore();
    const { ledger, posts } = recordingLedger();
    const result = await runFundingTick(
      {
        rates: fixedRate('0', 'm1:zero'),
        positions: positionsOf(longShort()),
        periods,
        margins: memoryFundingMarginApplier(),
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        ledger,
      },
      'm1',
    );
    expect(result).toEqual({ status: 'skipped', reason: 'no_legs', periodId: 'm1:zero' });
    expect(posts).toHaveLength(0);
    expect(await periods.isSettled('m1:zero')).toBe(true);
    // Distinguishes zero-rate period from oracle skip: settled with legCount 0, no skip row.
    expect(await periods.settledLegCount?.('m1:zero')).toBe(0);
    expect(await periods.lastSkip?.('m1:zero')).toBeNull();
  });

  it('no_rate is recorded as a skip, not as a settled zero-leg period', async () => {
    const periods = memoryFundingPeriodStore();
    const { ledger, posts } = recordingLedger();
    const fixed = new Date('2026-08-07T12:00:00.000Z');
    const result = await runFundingTick(
      {
        rates: { quote: async () => null },
        positions: positionsOf(longShort()),
        periods,
        margins: memoryFundingMarginApplier(),
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        ledger,
        now: () => fixed,
      },
      'm1',
    );
    expect(result.status).toBe('skipped');
    if (result.status !== 'skipped') return;
    expect(result.reason).toBe('no_rate');
    expect(result.periodId).toBeDefined();
    // Skip does NOT block settle identity — isSettled is false on the skip id.
    expect(await periods.isSettled(result.periodId!)).toBe(false);
    const skip = await periods.lastSkip?.(result.periodId!);
    expect(skip).toEqual({ reason: 'no_rate', marketId: 'm1' });
    expect(posts).toHaveLength(0);
  });

  it('no_positions is recorded as a skip (not settled_no_legs)', async () => {
    const periods = memoryFundingPeriodStore();
    const { ledger, posts } = recordingLedger();
    const result = await runFundingTick(
      {
        rates: fixedRate('0.0001', 'm1:empty-book'),
        positions: positionsOf([]),
        periods,
        margins: memoryFundingMarginApplier(),
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        ledger,
      },
      'm1',
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'no_positions', periodId: 'm1:empty-book' });
    expect(await periods.isSettled('m1:empty-book')).toBe(false);
    expect(await periods.lastSkip?.('m1:empty-book')).toEqual({ reason: 'no_positions', marketId: 'm1' });
    expect(posts).toHaveLength(0);
  });

  it('rate source is asked with marketId + clock (not invented inside tick)', async () => {
    const quote = vi.fn(async ({ marketId, at }: { marketId: string; at: Date }) => ({
      rate: '0.0001',
      periodId: `m1:${at.toISOString()}`,
      marketId,
    }));
    const fixed = new Date('2026-07-31T08:00:00.000Z');
    const { ledger } = recordingLedger();
    await runFundingTick(
      {
        rates: { quote },
        positions: positionsOf(longShort()),
        periods: memoryFundingPeriodStore(),
        margins: memoryFundingMarginApplier(),
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
        ledger,
        now: () => fixed,
      },
      'm1',
    );
    expect(quote).toHaveBeenCalledWith({ marketId: 'm1', at: fixed });
  });

  /**
   * C12 done bar: rate "1000000" → no ledger movement; refuse with clear code.
   * Fixture max is test-only, not Denon's product ceiling.
   */
  it('rate 1000000 posts nothing to the ledger and throws exceeds_max', async () => {
    const { ledger, posts } = recordingLedger();
    const margins = memoryFundingMarginApplier();
    await expect(
      runFundingTick(
        {
          rates: fixedRate('1000000', 'm1:absurd-rate'),
          positions: positionsOf(longShort()),
          periods: memoryFundingPeriodStore(),
          margins,
          maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
          ledger,
        },
        'm1',
      ),
    ).rejects.toMatchObject({ code: 'trade.funding_rate_exceeds_max' });
    expect(posts).toHaveLength(0);
    expect(margins.applied()).toHaveLength(0);
  });

  it('unset maxAbsRate refuses settlement — no ledger movement', async () => {
    const { ledger, posts } = recordingLedger();
    await expect(
      runFundingTick(
        {
          rates: fixedRate('0.0001', 'm1:no-bound'),
          positions: positionsOf(longShort()),
          periods: memoryFundingPeriodStore(),
          margins: memoryFundingMarginApplier(),
          maxAbsRate: null,
          ledger,
        },
        'm1',
      ),
    ).rejects.toMatchObject({ code: 'trade.funding_rate_bound_unconfigured' });
    expect(posts).toHaveLength(0);
  });
});
