/**
 * D-instruments-01 job-host wiring: the funding rate computer is off unless a poll interval is set, and with no
 * index source configured (main) it records gaps and a NotConnected `feed.market` refusal rather than a rate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { startFuturesJobs, type FuturesJobsConfig } from './futures-jobs.js';
import { currentFundingParams, BLANK_FUNDING_PARAMS } from './funding-params.js';
import { sqlFundingRatePeriodStore, sqlFundingSampleStore } from './funding-rate-computer.js';
import { openFundingTestDb, seedFundingParams, truncateFundingTables } from './funding-engine.test-harness.js';

const MARKET = '55555555-5555-4555-8555-555555555555';
const START = new Date('2026-10-20T00:00:00.000Z');
const NOW = new Date('2026-10-20T01:00:30.000Z');

describe('futures jobs: funding rate computer wiring', () => {
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

  function start(config: Partial<FuturesJobsConfig>) {
    const callbacks = new Map<number, Array<() => unknown>>();
    const setIntervalFn = ((fn: () => unknown, ms: number) => {
      callbacks.set(ms, [...(callbacks.get(ms) ?? []), fn]);
      return callbacks.size as never;
    }) as unknown as typeof setInterval;
    const handle = startFuturesJobs({
      sql: db.sql,
      ledger: { post: vi.fn(), balance: vi.fn() },
      matching: { depth: async () => ({ bids: [], asks: [], sequence: 0 }) } as never,
      bus: null,
      config: {
        enabled: true,
        liqIntervalMs: 60_000,
        fundingIntervalMs: null,
        fundingMarketIds: [MARKET],
        fundingMaxAbsRate: '1', // TEST bound
        ...config,
      },
      now: () => NOW,
      setIntervalFn,
      clearIntervalFn: (() => {}) as never,
    });
    return { handle, callbacks };
  }

  it('is not scheduled by default: blank poll interval changes nothing', () => {
    const { handle } = start({});
    expect(handle.host.list().filter((n) => n.includes('funding_rate'))).toEqual([]);
    handle.stop();
  });

  it('is scheduled per funding market once a poll interval is set', () => {
    const { handle } = start({ fundingComputerPollMs: 5_000 });
    expect(handle.host.list()).toContain(`futures.funding_rate.${MARKET}`);
    handle.stop();
  });

  it('with no index source configured it samples gaps and refuses the period as feed.market; it publishes no rate', async () => {
    await seedFundingParams(db, MARKET, {
      ...BLANK_FUNDING_PARAMS,
      baseComponent: '0.0001',
      cap: '0.05',
      cadenceSeconds: 60,
      trimRatioBps: 200,
      minSamples: 1,
      periodSeconds: 3600,
      periodAnchor: START.toISOString(),
    });
    // Index numbers are set, but no feed is configured on main.
    await db.sql`INSERT INTO trade.funding_index_sources (id, market_id, version, sources, min_sources, outlier_band_bps, max_age_seconds,
        operator_id, approver_id, reason, approval_id)
      VALUES ('77777777-7777-4777-8777-777777777777', ${MARKET}, 1, '[{"sourceId":"src-a","weight":1,"enabled":true}]'::jsonb, 1, 500, 30,
        'op', 'ap', 'fixture', 'ap-fixture')`;
    const { handle, callbacks } = start({ fundingComputerPollMs: 5_000 });
    for (const fn of callbacks.get(5_000) ?? []) await fn();
    const samples = await sqlFundingSampleStore(db.sql).window(
      MARKET,
      new Date(START.getTime() + 3_600_000),
      new Date(NOW.getTime() + 60_000),
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ mark: null, index: null });
    expect(samples[0]!.gapReason).toContain('feed.market');
    const periods = await sqlFundingRatePeriodStore(db.sql).recent({ marketId: MARKET, limit: 5 });
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ status: 'refused', code: 'feed.market', rate: null });
    expect(handle.getPublishedRate(MARKET)).toBeNull();
    expect((await currentFundingParams(db.sql, MARKET)).version).toBe('1');
    handle.stop();
  });
});
