/**
 * D-instruments-01 funding rate computer, against real Postgres (TEST_DATABASE_URL).
 * Every figure here is a TEST fixture. None is an owner number.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { parseAmount as amt, type PostRequest } from '@intafaced/ledger-client';
import {
  FUNDING_INDEX_STALE,
  FUNDING_PERIOD_OPEN,
  FUNDING_SAMPLES_INSUFFICIENT,
  FUNDING_WINDOW_OVERLAPS,
  computeFundingPeriod,
  indexHealthFromProvider,
  indexProviderFromFeed,
  latestClosedWindow,
  runFundingComputerJob,
  sqlFundingRatePeriodStore,
  sqlFundingSampleStore,
  takeFundingSample,
  type ComputePeriodDeps,
  type IndexHealth,
  type IndexProvider,
} from './funding-rate-computer.js';
import { BLANK_FUNDING_PARAMS, FUNDING_RATE_UNSET, currentFundingParams, type FundingParams } from './funding-params.js';
import { memoryFundingRateBook, periodIdFor, type FundingRateEntry } from './funding-rate-source.js';
import { memoryFundingMarginApplier, memoryFundingPeriodStore, runFundingTick } from './funding-tick.js';
import type { FundingOpenPosition } from './funding-settlement.js';
import { notConnectedIndexFeed, type IndexFeed } from './index-construction.js';
import { openFundingTestDb, seedFundingParams, seedSamples, truncateFundingTables } from './funding-engine.test-harness.js';

const MARKET = '55555555-5555-4555-8555-555555555555';
const START = new Date('2026-10-20T00:00:00.000Z');
const END = new Date('2026-10-20T01:00:00.000Z');
const NOW = new Date('2026-10-20T01:00:30.000Z');
const CADENCE = 60; // TEST: 60 one-minute slots in the hour
const GREEN: IndexHealth = { state: 'green' };

/** TEST owner numbers: a full, valid set. */
const FULL: FundingParams = {
  ...BLANK_FUNDING_PARAMS,
  baseComponent: '0.0001',
  cap: '0.05',
  cadenceSeconds: CADENCE,
  trimRatioBps: 200,
  minSamples: 60,
};

describe('funding rate computer', () => {
  let db: TestDatabase;
  let published: FundingRateEntry[];
  let health: IndexHealth;
  let maxAbsRate: string | null;

  beforeAll(async () => {
    db = await openFundingTestDb();
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);
  beforeEach(async () => {
    await truncateFundingTables(db);
    published = [];
    health = GREEN;
    maxAbsRate = '1'; // TEST bound, not product law
  });

  function deps(over: Partial<ComputePeriodDeps> = {}): ComputePeriodDeps {
    return {
      params: (marketId) => currentFundingParams(db.sql, marketId),
      samples: sqlFundingSampleStore(db.sql),
      periods: sqlFundingRatePeriodStore(db.sql),
      indexHealth: { check: async () => health },
      publish: (entry) => published.push(entry),
      maxAbsRate,
      now: () => NOW,
      ...over,
    };
  }
  const close = (over: Partial<ComputePeriodDeps> = {}) =>
    computeFundingPeriod(deps(over), { marketId: MARKET, periodStart: START, periodEnd: END });

  it('rate equals premium plus base for 60 samples of mark 101 against index 100, stored with its inputs', async () => {
    await seedFundingParams(db, MARKET, FULL);
    await seedSamples(db, MARKET, START, 60, CADENCE);
    const result = await close();
    // (101 - 100) / 100 = 0.01; + base 0.0001 = 0.0101; under the 0.05 cap
    expect(result).toMatchObject({ status: 'published', rate: '0.0101', clamped: false, replayed: false });
    const [row] = await db.sql<Array<Record<string, unknown>>>`SELECT * FROM trade.funding_rate_periods WHERE market_id = ${MARKET}`;
    expect(row).toMatchObject({
      period_id: periodIdFor(MARKET, START.toISOString()),
      status: 'published',
      rate: '0.0101',
      premium: '0.01',
      base_component: '0.0001',
      cap: '0.05',
      clamped: false,
      code: null,
    });
    expect(row!.inputs).toMatchObject({
      paramsVersion: '1',
      params: { baseComponent: '0.0001', cap: '0.05', cadenceSeconds: 60, trimRatioBps: 200, minSamples: 60 },
      expectedSamples: 60,
      validSamples: 60,
      gapSamples: 0,
      trimmedPerTail: 1,
      keptSamples: 58,
      rawRate: '0.0101',
    });
    // Published through the rate source seam, with the period named and its end stated.
    expect(published).toEqual([
      {
        marketId: MARKET,
        periodId: periodIdFor(MARKET, START.toISOString()),
        rate: '0.0101',
        asOfMs: NOW.getTime(),
        periodEndIso: END.toISOString(),
      },
    ]);
  });

  it.each(['baseComponent', 'cap', 'cadenceSeconds', 'trimRatioBps', 'minSamples'] as const)(
    'a blank %s refuses the period with trade.funding_rate_unset, records it, and publishes nothing',
    async (field) => {
      await seedFundingParams(db, MARKET, { ...FULL, [field]: null });
      await seedSamples(db, MARKET, START, 60, CADENCE);
      const result = await close();
      expect(result).toMatchObject({ status: 'refused', code: FUNDING_RATE_UNSET });
      expect(published).toEqual([]);
      const record = await sqlFundingRatePeriodStore(db.sql).get(periodIdFor(MARKET, START.toISOString()));
      expect(record).toMatchObject({ status: 'refused', code: FUNDING_RATE_UNSET, rate: null });
      expect(record!.inputs).toMatchObject({ missing: [field] });
    },
  );

  it('a blank cap is recorded and the funding tick plans no leg', async () => {
    await seedFundingParams(db, MARKET, { ...FULL, cap: null });
    await seedSamples(db, MARKET, START, 60, CADENCE);
    const book = memoryFundingRateBook({ policy: { maxAgeMs: 0 } });
    const result = await close({ publish: (e) => book.set(e) });
    expect(result).toMatchObject({ status: 'refused', code: 'trade.funding_rate_unset' });

    const posts: PostRequest[] = [];
    const longShort: FundingOpenPosition[] = [
      { positionId: 'pl', userId: 'u1', side: 'long', size: amt('1'), entryPrice: amt('100'), marginAsset: 'USDT' },
      { positionId: 'ps', userId: 'u2', side: 'short', size: amt('1'), entryPrice: amt('100'), marginAsset: 'USDT' },
    ];
    const tick = await runFundingTick(
      {
        rates: book.source(),
        positions: { listOpenForMarket: async () => longShort },
        periods: memoryFundingPeriodStore(),
        ledger: {
          async post(req: PostRequest) {
            posts.push(req);
            return { id: 'tx' } as never;
          },
        },
        margins: memoryFundingMarginApplier(),
        maxAbsRate: '1',
        now: () => NOW,
      },
      MARKET,
    );
    expect(tick).toMatchObject({ status: 'skipped', reason: 'no_rate' });
    expect(posts).toEqual([]);
  });

  it('a published rate reaches the funding tick through the rate source, and the tick settles that period', async () => {
    await seedFundingParams(db, MARKET, FULL);
    await seedSamples(db, MARKET, START, 60, CADENCE);
    const book = memoryFundingRateBook({ policy: { maxAgeMs: 0 } });
    await close({ publish: (e) => book.set(e) });

    const posts: PostRequest[] = [];
    const longShort: FundingOpenPosition[] = [
      { positionId: 'pl', userId: 'u1', side: 'long', size: amt('1'), entryPrice: amt('100'), marginAsset: 'USDT' },
      { positionId: 'ps', userId: 'u2', side: 'short', size: amt('1'), entryPrice: amt('100'), marginAsset: 'USDT' },
    ];
    const tick = await runFundingTick(
      {
        rates: book.source(),
        positions: { listOpenForMarket: async () => longShort },
        periods: memoryFundingPeriodStore(),
        ledger: {
          async post(req: PostRequest) {
            posts.push(req);
            return { id: 'tx' } as never;
          },
        },
        margins: memoryFundingMarginApplier(),
        maxAbsRate: '1',
        now: () => NOW,
      },
      MARKET,
    );
    expect(tick).toMatchObject({ status: 'settled', rate: '0.0101', periodId: periodIdFor(MARKET, START.toISOString()) });
    expect(posts.length).toBeGreaterThan(0);
  });

  it('clamps an over-cap rate to the cap and flags it, on both sides', async () => {
    await seedFundingParams(db, MARKET, { ...FULL, cap: '0.005' });
    await seedSamples(db, MARKET, START, 60, CADENCE);
    const up = await close();
    expect(up).toMatchObject({ status: 'published', rate: '0.005', clamped: true });
    expect(up.status === 'published' && up.record).toMatchObject({ clamped: true, inputs: { rawRate: '0.0101' } });

    const start2 = new Date('2026-10-19T23:00:00.000Z');
    await seedSamples(db, MARKET, start2, 60, CADENCE, () => ({ mark: '90', index: '100' }));
    const down = await computeFundingPeriod(deps(), { marketId: MARKET, periodStart: start2, periodEnd: START });
    // -0.1 + 0.0001 is far below -0.005
    expect(down).toMatchObject({ status: 'published', rate: '-0.005', clamped: true });
  });

  it('fewer valid samples than the minimum refuses the period', async () => {
    await seedFundingParams(db, MARKET, FULL);
    await seedSamples(db, MARKET, START, 59, CADENCE);
    const result = await close();
    expect(result).toMatchObject({ status: 'refused', code: FUNDING_SAMPLES_INSUFFICIENT });
    expect(published).toEqual([]);
    const record = await sqlFundingRatePeriodStore(db.sql).get(periodIdFor(MARKET, START.toISOString()));
    expect(record!.inputs).toMatchObject({ expectedSamples: 60, validSamples: 59, gapSamples: 1 });
  });

  it('drops an outlier by trimming, and a zero trim shows what the outlier would have done', async () => {
    const outlier = (i: number) => (i === 17 ? { mark: '200', index: '100' } : { mark: '101', index: '100' });
    await seedFundingParams(db, MARKET, FULL);
    await seedSamples(db, MARKET, START, 60, CADENCE, outlier);
    const trimmed = await close();
    expect(trimmed).toMatchObject({ status: 'published', rate: '0.0101' });
    const record = trimmed.status === 'published' ? trimmed.record : null;
    expect(record!.inputs.droppedPremiums).toEqual(expect.arrayContaining(['1']));
    expect(record!.inputs).toMatchObject({ trimmedPerTail: 1, keptSamples: 58 });

    // Same samples, trim 0 (a stated choice, not blank): the outlier moves the rate. (59*0.01 + 1)/60 = 0.0265
    const start2 = new Date('2026-10-19T23:00:00.000Z');
    await seedFundingParams(db, MARKET, { ...FULL, trimRatioBps: 0 });
    await seedSamples(db, MARKET, start2, 60, CADENCE, outlier);
    const untrimmed = await computeFundingPeriod(deps(), { marketId: MARKET, periodStart: start2, periodEnd: START });
    expect(untrimmed).toMatchObject({ status: 'published', rate: '0.0266' });
  });

  it('a gap is not zero: it is left out of the average and counts against the minimum', async () => {
    await seedFundingParams(db, MARKET, { ...FULL, minSamples: 50 });
    // 50 valid slots, 10 explicit gap rows (null mark). Averaged as zero these would pull the premium to 0.00833.
    await seedSamples(db, MARKET, START, 60, CADENCE, (i) => (i % 6 === 5 ? { mark: null, index: '100' } : { mark: '101', index: '100' }));
    const ok = await close();
    expect(ok).toMatchObject({ status: 'published', rate: '0.0101' });
    expect(ok.status === 'published' && ok.record.inputs).toMatchObject({ validSamples: 50, gapSamples: 10, gapReasons: { test_gap: 10 } });

    // The same 50 valid with a minimum of 51: the gaps count against it.
    const start2 = new Date('2026-10-19T23:00:00.000Z');
    await seedFundingParams(db, MARKET, { ...FULL, minSamples: 51 });
    await seedSamples(db, MARKET, start2, 60, CADENCE, (i) => (i % 6 === 5 ? { mark: null, index: '100' } : { mark: '101', index: '100' }));
    const refused = await computeFundingPeriod(deps(), { marketId: MARKET, periodStart: start2, periodEnd: START });
    expect(refused).toMatchObject({ status: 'refused', code: FUNDING_SAMPLES_INSUFFICIENT });
  });

  it('slots with no row at all are gaps too', async () => {
    await seedFundingParams(db, MARKET, { ...FULL, minSamples: 40 });
    await seedSamples(db, MARKET, START, 40, CADENCE); // 20 slots never recorded
    const r = await close();
    expect(r).toMatchObject({ status: 'published', rate: '0.0101' });
    expect(r.status === 'published' && r.record.inputs).toMatchObject({ expectedSamples: 60, validSamples: 40, gapSamples: 20 });
  });

  it('a stale index pauses the period instead of publishing, and a later healthy run publishes it', async () => {
    await seedFundingParams(db, MARKET, FULL);
    await seedSamples(db, MARKET, START, 60, CADENCE);
    health = { state: 'red', code: 'trade.index_stale', message: 'trade.index_stale: 0 fresh source(s), floor 2' };
    const paused = await close();
    expect(paused).toMatchObject({ status: 'paused', code: FUNDING_INDEX_STALE });
    expect(published).toEqual([]);
    const store = sqlFundingRatePeriodStore(db.sql);
    expect(await store.get(paused.periodId)).toMatchObject({ status: 'paused', rate: null, code: FUNDING_INDEX_STALE });

    health = GREEN;
    const resumed = await close();
    expect(resumed).toMatchObject({ status: 'published', rate: '0.0101' });
    expect(await store.get(paused.periodId)).toMatchObject({ status: 'published', attempts: 2, code: null });
    expect(published).toHaveLength(1);
  });

  it('an index that cannot be built at all (NotConnected feed.market) refuses and publishes nothing', async () => {
    await seedFundingParams(db, MARKET, FULL);
    await seedSamples(db, MARKET, START, 60, CADENCE);
    const provider = indexProviderFromFeed({
      feed: notConnectedIndexFeed(),
      sources: async (m) => ({
        marketId: m,
        version: '1',
        config: {
          sources: [{ sourceId: 'src-a', weight: 1, enabled: true }],
          params: { minSources: 1, outlierBandBps: 500, maxAgeSeconds: 30 },
        },
        operatorId: null,
        approverId: null,
        reason: null,
        approvalId: null,
        createdAt: null,
      }),
    });
    const result = await close({ indexHealth: indexHealthFromProvider(provider) });
    expect(result).toMatchObject({ status: 'refused', code: 'feed.market' });
    expect(published).toEqual([]);
  });

  it('replay of a closed period returns the stored rate, even after samples and parameters change', async () => {
    await seedFundingParams(db, MARKET, FULL);
    await seedSamples(db, MARKET, START, 60, CADENCE);
    const first = await close();
    expect(first).toMatchObject({ status: 'published', rate: '0.0101', replayed: false });
    published.length = 0;

    await seedFundingParams(db, MARKET, { ...FULL, cap: null, baseComponent: '0.04' });
    await db.sql`DELETE FROM trade.funding_rate_samples WHERE market_id = ${MARKET}`;
    const replay = await close();
    expect(replay).toMatchObject({ status: 'published', rate: '0.0101', replayed: true });
    expect(published).toEqual([]); // not re-published unless asked

    const again = await computeFundingPeriod(deps(), { marketId: MARKET, periodStart: START, periodEnd: END }, { republish: true });
    expect(again).toMatchObject({ status: 'published', rate: '0.0101', replayed: true });
    expect(published.map((e) => e.rate)).toEqual(['0.0101']);
  });

  it('a published period cannot be rewritten or deleted in the database', async () => {
    await seedFundingParams(db, MARKET, FULL);
    await seedSamples(db, MARKET, START, 60, CADENCE);
    await close();
    await expect(db.sql`UPDATE trade.funding_rate_periods SET rate = '0.5'`).rejects.toThrow(/closed once published/);
    await expect(db.sql`DELETE FROM trade.funding_rate_periods`).rejects.toThrow(/closed once published/);
  });

  it('a computed rate is held to the same magnitude bound as an S2S publish', async () => {
    await seedFundingParams(db, MARKET, FULL);
    await seedSamples(db, MARKET, START, 60, CADENCE);
    maxAbsRate = null;
    expect(await close()).toMatchObject({ status: 'refused', code: 'trade.funding_rate_bound_unconfigured' });
    maxAbsRate = '0.005';
    expect(await close()).toMatchObject({ status: 'refused', code: 'trade.funding_rate_exceeds_max' });
    expect(published).toEqual([]);
    maxAbsRate = '1';
    expect(await close()).toMatchObject({ status: 'published', rate: '0.0101' });
  });

  it('refuses to compute a period that has not closed', async () => {
    await seedFundingParams(db, MARKET, FULL);
    await expect(
      computeFundingPeriod(deps({ now: () => new Date('2026-10-20T00:30:00.000Z') }), {
        marketId: MARKET,
        periodStart: START,
        periodEnd: END,
      }),
    ).rejects.toMatchObject({ code: FUNDING_PERIOD_OPEN });
    expect(await sqlFundingRatePeriodStore(db.sql).recent({ marketId: MARKET, limit: 10 })).toEqual([]);
  });
});

describe('funding sampler and job', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await openFundingTestDb();
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);
  beforeEach(async () => {
    await truncateFundingTables(db);
  });

  const okIndex = (price: string): IndexProvider => ({ current: async () => ({ ok: true, price: amt(price) }) });
  function samplerDeps(mark: string | null, index: IndexProvider) {
    return {
      params: (m: string) => currentFundingParams(db.sql, m),
      marks: { markPrice: async () => mark },
      index,
      samples: sqlFundingSampleStore(db.sql),
    };
  }

  it('records the slot once; a second call in the same slot keeps the first row', async () => {
    await seedFundingParams(db, MARKET, FULL);
    const at = new Date('2026-10-20T00:00:42.000Z');
    const first = await takeFundingSample(samplerDeps('101', okIndex('100')), MARKET, at);
    expect(first).toMatchObject({ status: 'recorded', sampledAt: '2026-10-20T00:00:00.000Z', gap: false });
    await takeFundingSample(samplerDeps('150', okIndex('100')), MARKET, new Date('2026-10-20T00:00:55.000Z'));
    const rows = await sqlFundingSampleStore(db.sql).window(MARKET, START, END);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mark: amt('101'), index: amt('100'), gapReason: null });
  });

  it('a missing mark or an index that is not connected is stored as a gap, never zero', async () => {
    await seedFundingParams(db, MARKET, FULL);
    const noMark = await takeFundingSample(samplerDeps(null, okIndex('100')), MARKET, START);
    expect(noMark).toMatchObject({ gap: true, gapReason: 'mark_unavailable' });
    const provider = indexProviderFromFeed({
      feed: notConnectedIndexFeed(),
      sources: async (m) => ({
        marketId: m,
        version: '1',
        config: { sources: [], params: { minSources: 1, outlierBandBps: 500, maxAgeSeconds: 30 } },
        operatorId: null,
        approverId: null,
        reason: null,
        approvalId: null,
        createdAt: null,
      }),
    });
    const noIndex = await takeFundingSample(samplerDeps('101', provider), MARKET, new Date(START.getTime() + 60_000));
    expect(noIndex).toMatchObject({ gap: true, gapReason: 'feed.market' });
    const rows = await sqlFundingSampleStore(db.sql).window(MARKET, START, END);
    expect(rows.map((r) => [r.mark, r.index])).toEqual([
      [null, amt('100')],
      [amt('101'), null],
    ]);
  });

  it('with a blank cadence there is no slot: nothing is recorded', async () => {
    await seedFundingParams(db, MARKET, { ...FULL, cadenceSeconds: null });
    const r = await takeFundingSample(samplerDeps('101', okIndex('100')), MARKET, START);
    expect(r).toMatchObject({ status: 'skipped', code: FUNDING_RATE_UNSET });
    expect(await sqlFundingSampleStore(db.sql).window(MARKET, START, END)).toEqual([]);
  });

  it('index provider: blank index numbers refuse, quotes build, a red venue grade pauses', async () => {
    const quotes = [
      { sourceId: 'src-a', price: amt('100'), observedAt: new Date(NOW.getTime() - 1000) },
      { sourceId: 'src-b', price: amt('102'), observedAt: new Date(NOW.getTime() - 1000) },
    ];
    const feed: IndexFeed = { read: async () => ({ connected: true, quotes }) };
    const cfg =
      (params: { minSources: number | null; outlierBandBps: number | null; maxAgeSeconds: number | null }) => async (m: string) => ({
        marketId: m,
        version: '3',
        config: {
          sources: [
            { sourceId: 'src-a', weight: 1, enabled: true },
            { sourceId: 'src-b', weight: 1, enabled: true },
          ],
          params,
        },
        operatorId: null,
        approverId: null,
        reason: null,
        approvalId: null,
        createdAt: null,
      });
    const blank = indexProviderFromFeed({ feed, sources: cfg({ minSources: null, outlierBandBps: 500, maxAgeSeconds: 30 }) });
    expect(await blank.current(MARKET, NOW)).toMatchObject({ ok: false, health: 'refused', code: 'trade.index_params_unset' });

    const good = indexProviderFromFeed({ feed, sources: cfg({ minSources: 2, outlierBandBps: 500, maxAgeSeconds: 30 }) });
    expect(await good.current(MARKET, NOW)).toEqual({ ok: true, price: amt('101') });

    const red = indexProviderFromFeed({
      feed,
      sources: cfg({ minSources: 2, outlierBandBps: 500, maxAgeSeconds: 30 }),
      venueHealth: () => ({ configured: true, grade: 'F' }) as never,
    });
    expect(await red.current(MARKET, NOW)).toMatchObject({ ok: false, health: 'red', code: FUNDING_INDEX_STALE });
    const notRed = indexProviderFromFeed({
      feed,
      sources: cfg({ minSources: 2, outlierBandBps: 500, maxAgeSeconds: 30 }),
      venueHealth: () => ({ configured: true, grade: null }) as never,
    });
    expect((await notRed.current(MARKET, NOW)).ok).toBe(true);
  });

  it('latestClosedWindow places the window from the owner period and anchor, and is null while blank or before the first close', () => {
    const p = { ...BLANK_FUNDING_PARAMS, periodSeconds: 3600, periodAnchor: '2026-10-20T00:00:00.000Z' };
    expect(latestClosedWindow(BLANK_FUNDING_PARAMS, NOW)).toBeNull();
    expect(latestClosedWindow({ ...p, periodAnchor: null }, NOW)).toBeNull();
    expect(latestClosedWindow(p, new Date('2026-10-20T00:59:59.000Z'))).toBeNull();
    const w = latestClosedWindow(p, new Date('2026-10-20T03:10:00.000Z'));
    expect(w!.periodStart.toISOString()).toBe('2026-10-20T02:00:00.000Z');
    expect(w!.periodEnd.toISOString()).toBe('2026-10-20T03:00:00.000Z');
  });

  it('the job with a blank period window records one trade.funding_rate_unset refusal per parameter version', async () => {
    await seedFundingParams(db, MARKET, FULL);
    const published: FundingRateEntry[] = [];
    const jobDeps = {
      ...samplerDeps('101', okIndex('100')),
      periods: sqlFundingRatePeriodStore(db.sql),
      indexHealth: { check: async () => GREEN },
      publish: (e: FundingRateEntry) => published.push(e),
      maxAbsRate: '1',
      now: () => NOW,
    };
    const a = await runFundingComputerJob(jobDeps, MARKET);
    const b = await runFundingComputerJob(jobDeps, MARKET);
    expect(a.period).toMatchObject({ status: 'refused', code: FUNDING_RATE_UNSET });
    expect(b.period).toMatchObject({ status: 'refused', code: FUNDING_RATE_UNSET });
    const rows = await sqlFundingRatePeriodStore(db.sql).recent({ marketId: MARKET, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 1, periodStart: null });
    expect(rows[0]!.inputs).toMatchObject({ missing: ['periodSeconds', 'periodAnchor'] });
    expect(published).toEqual([]);
  });

  describe('a period length or anchor change never charges funding time twice or skips it', () => {
    const at = (iso: string) => new Date(iso);
    function jobDeps(now: Date, published: FundingRateEntry[]) {
      return {
        ...samplerDeps('101', okIndex('100')),
        periods: sqlFundingRatePeriodStore(db.sql),
        indexHealth: { check: async () => GREEN },
        publish: (e: FundingRateEntry) => published.push(e),
        maxAbsRate: '1',
        now: () => now,
      };
    }
    async function settleFirstHour(published: FundingRateEntry[]) {
      await seedFundingParams(db, MARKET, { ...FULL, periodSeconds: 3600, periodAnchor: START.toISOString() });
      await seedSamples(db, MARKET, START, 60, CADENCE);
      const first = await runFundingComputerJob(jobDeps(NOW, published), MARKET);
      expect(first.period).toMatchObject({ status: 'published', periodId: periodIdFor(MARKET, START.toISOString()) });
      published.length = 0;
    }

    it('a re-anchored window that starts inside the settled hour is refused, recorded and not published', async () => {
      const published: FundingRateEntry[] = [];
      await settleFirstHour(published);
      await seedFundingParams(db, MARKET, { ...FULL, periodSeconds: 3600, periodAnchor: '2026-10-19T23:30:00.000Z' });
      const run = await runFundingComputerJob(jobDeps(at('2026-10-20T01:10:00.000Z'), published), MARKET);
      expect(run.period).toMatchObject({ status: 'refused', code: FUNDING_WINDOW_OVERLAPS });
      expect(published).toEqual([]);
      const rows = await db.sql<Array<{ status: string; period_start: Date }>>`
        SELECT status, period_start FROM trade.funding_rate_periods WHERE market_id = ${MARKET} AND status = 'published'`;
      expect(rows.map((r) => r.period_start.toISOString())).toEqual([START.toISOString()]);
    });

    it('a shorter period skips the half hour already settled and publishes the first window after it', async () => {
      const published: FundingRateEntry[] = [];
      await settleFirstHour(published);
      await seedFundingParams(db, MARKET, { ...FULL, minSamples: 30, periodSeconds: 1800, periodAnchor: START.toISOString() });
      const early = await runFundingComputerJob(jobDeps(at('2026-10-20T01:10:00.000Z'), published), MARKET);
      expect(early.period).toMatchObject({ status: 'refused', code: FUNDING_WINDOW_OVERLAPS });
      await seedSamples(db, MARKET, END, 30, CADENCE);
      const next = await runFundingComputerJob(jobDeps(at('2026-10-20T01:30:30.000Z'), published), MARKET);
      expect(next.period).toMatchObject({ status: 'published', periodId: periodIdFor(MARKET, END.toISOString()) });
      expect(published.map((e) => [e.periodId, e.periodEndIso])).toEqual([
        [periodIdFor(MARKET, END.toISOString()), '2026-10-20T01:30:00.000Z'],
      ]);
    });

    it('a longer period that reuses the settled period id is refused, not replayed as if 01:00 to 02:00 were paid', async () => {
      const published: FundingRateEntry[] = [];
      await settleFirstHour(published);
      await seedFundingParams(db, MARKET, { ...FULL, periodSeconds: 7200, periodAnchor: START.toISOString() });
      const run = await runFundingComputerJob(jobDeps(at('2026-10-20T02:10:00.000Z'), published), MARKET);
      expect(run.period).toMatchObject({ status: 'refused', code: FUNDING_WINDOW_OVERLAPS });
      expect(published).toEqual([]);
    });
  });

  it('the job computes the latest closed period and re-publishes it on the next run', async () => {
    await seedFundingParams(db, MARKET, { ...FULL, periodSeconds: 3600, periodAnchor: START.toISOString() });
    await seedSamples(db, MARKET, START, 60, CADENCE);
    const published: FundingRateEntry[] = [];
    const jobDeps = {
      ...samplerDeps('101', okIndex('100')),
      periods: sqlFundingRatePeriodStore(db.sql),
      indexHealth: { check: async () => GREEN },
      publish: (e: FundingRateEntry) => published.push(e),
      maxAbsRate: '1',
      now: () => NOW,
    };
    const first = await runFundingComputerJob(jobDeps, MARKET);
    expect(first.period).toMatchObject({ status: 'published', rate: '0.0101', replayed: false });
    const second = await runFundingComputerJob(jobDeps, MARKET);
    expect(second.period).toMatchObject({ status: 'published', rate: '0.0101', replayed: true });
    expect(published.map((e) => e.rate)).toEqual(['0.0101', '0.0101']);
  });
});
