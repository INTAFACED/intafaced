/**
 * Every job `startFuturesJobs` schedules, run once through the host's own interval callback, with each tick replaced
 * by a recorder: what the module hands its ticks, on every path it has, read off their inputs.
 *
 * With every setting on (jobs, funding interval, funding markets, the funding computer's poll, a published ladder, a
 * settlement stamp) each scheduled job is driven, and the test checks the list it drove is the list the host holds, so
 * a new job cannot skip these checks. The module is fresh-imported with the test-only ladder table watched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';

const runs = vi.hoisted(() => ({ inputs: [] as Array<{ tick: string; input: unknown }> }));

/** Each tick the jobs can run, by the module that defines it, replaced by a recorder. */
vi.mock('./liquidation-tick.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runLiquidationTick: async (input: unknown) => {
    runs.inputs.push({ tick: 'runLiquidationTick', input });
    return { scanned: 0, liquidated: 0, partial: 0, marginCalls: 0, errored: 0, parked: 0, items: [] };
  },
}));
vi.mock('./funding-tick.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runFundingTick: async (input: unknown, marketId: string) => {
    runs.inputs.push({ tick: 'runFundingTick', input: { input, marketId } });
    return { status: 'skipped', reason: 'no_rate', periodId: `${marketId}:no_rate:x` };
  },
}));
vi.mock('./dated-futures-settlement.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runDatedFuturesSettlementScan: async (input: unknown) => {
    runs.inputs.push({ tick: 'runDatedFuturesSettlementScan', input });
    return [];
  },
}));
vi.mock('./futures-payouts.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runPayoutTick: async (input: unknown) => {
    runs.inputs.push({ tick: 'runPayoutTick', input });
    return { paid: [], errored: [] };
  },
}));
vi.mock('./funding-rate-computer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runFundingComputerJob: async (input: unknown, marketId: string) => {
    runs.inputs.push({ tick: 'runFundingComputerJob', input: { input, marketId } });
  },
}));

const POLICY: FuturesLadderPolicy = {
  tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 }],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 10_000,
};

/** Distinct intervals, so each scheduled period can be traced to the setting it came from. */
const LIQ_MS = 11_000;
const FUNDING_MS = 22_000;
const COMPUTER_MS = 33_000;

afterEach(() => {
  vi.doUnmock('./ladder-policy.test-harness.js');
  vi.resetModules();
});

/** Every key at any depth of plain objects and arrays inside `value`. */
function deepKeys(value: unknown, seen = new Set<unknown>()): string[] {
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...deepKeys(v, seen)]);
}

/** Every primitive at any depth of plain objects and arrays inside `value`. */
function deepValues(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === null || typeof value !== 'object') return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) return [];
  return Object.values(value).flatMap((v) => deepValues(v, seen));
}

async function driveAll(extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  runs.inputs.length = 0;
  const harness: string[] = [];
  vi.resetModules();
  vi.doMock('./ladder-policy.test-harness.js', async (importOriginal) => {
    harness.push('loaded');
    return importOriginal();
  });
  const mod = await import('./futures-jobs.js');
  const scheduled: Array<{ ms: number; fn: () => unknown }> = [];
  const handle = mod.startFuturesJobs({
    sql: Object.assign(() => Promise.resolve([]), { unsafe: () => Promise.resolve([]) }) as never,
    ledger: { post: vi.fn(), balance: vi.fn() },
    matching: { depth: vi.fn(async () => ({ bids: [], asks: [], sequence: 0 })) } as never,
    bus: null,
    setIntervalFn: partial<typeof setInterval>((fn: () => unknown, ms: number) => {
      scheduled.push({ ms, fn });
      return scheduled.length;
    }),
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    onError: () => undefined,
    config: {
      enabled: true,
      liqIntervalMs: LIQ_MS,
      fundingIntervalMs: FUNDING_MS,
      fundingComputerPollMs: COMPUTER_MS,
      fundingMarketIds: ['m1', 'm2'],
      fundingMaxAbsRate: '0.01',
      ...config,
    },
    ...extra,
  } as never);
  const names = handle.host.list().sort();
  for (const job of scheduled) await job.fn();
  await vi.waitFor(() => expect(runs.inputs.length).toBeGreaterThanOrEqual(scheduled.length));
  handle.stop();
  return { mod, handle, names, scheduled, inputs: [...runs.inputs], harness };
}

describe('every job the futures jobs schedule, driven once', () => {
  it('drives each scheduled job, and each reaches its own tick', async () => {
    const { names, scheduled, inputs } = await driveAll();
    expect(names).toEqual([
      'futures.dated_settlement',
      'futures.funding.m1',
      'futures.funding.m2',
      'futures.funding_rate.m1',
      'futures.funding_rate.m2',
      'futures.liquidation',
      'futures.payouts',
    ]);
    expect(scheduled).toHaveLength(names.length);
    expect(inputs.map((r) => r.tick).sort()).toEqual(
      [
        'runDatedFuturesSettlementScan',
        'runFundingComputerJob',
        'runFundingComputerJob',
        'runFundingTick',
        'runFundingTick',
        'runLiquidationTick',
        'runPayoutTick',
      ].sort(),
    );
  });

  it('schedules each job only at an interval the config named, never an 8h period of its own', async () => {
    const { scheduled } = await driveAll();
    expect(scheduled.map((s) => s.ms).sort((a, b) => a - b)).toEqual([
      LIQ_MS,
      LIQ_MS,
      LIQ_MS,
      FUNDING_MS,
      FUNDING_MS,
      COMPUTER_MS,
      COMPUTER_MS,
    ]);
    // No funding interval named: no funding tick at any period, and still no 8h one.
    const blank = await driveAll({}, { fundingIntervalMs: null, fundingComputerPollMs: null });
    expect(blank.names).toEqual(['futures.dated_settlement', 'futures.liquidation', 'futures.payouts']);
    expect(blank.scheduled.map((s) => s.ms)).toEqual([LIQ_MS, LIQ_MS, LIQ_MS]);
    for (const run of [...blank.inputs, ...(await driveAll()).inputs]) {
      expect(deepValues(run.input), run.tick).not.toContain(28_800_000);
    }
  });

  it('hands no tick an ADL policy, a reduce cap or a maintenance number of its own', async () => {
    for (const extra of [{}, { ladderPolicy: POLICY }]) {
      const { inputs, handle } = await driveAll(extra);
      for (const run of inputs) {
        const keys = deepKeys(run.input);
        expect(
          keys.filter((k) => /^adl|maxReduceBps|candidates/i.test(k)),
          run.tick,
        ).toEqual([]);
        // The one maintenance number any tick sees is inside the ladder the owner published.
        const outside =
          keys.filter((k) => k === 'maintenanceBps').length - (run.tick === 'runLiquidationTick' && extra.ladderPolicy ? 1 : 0);
        expect(outside, run.tick).toBe(0);
      }
      expect(deepKeys(handle).filter((k) => k === 'maintenanceBps')).toHaveLength(extra.ladderPolicy ? 1 : 0);
      const liquidation = inputs.find((r) => r.tick === 'runLiquidationTick')!.input as { ladder: { policy?: unknown } };
      if (extra.ladderPolicy) expect(liquidation.ladder.policy).toBe(POLICY);
      else expect(liquidation.ladder.policy).toBeUndefined();
      expect(handle.ladderGate.policy).toBe(extra.ladderPolicy);
    }
  });

  it('never loads the test-only ladder table, on import or on any tick', async () => {
    expect((await driveAll()).harness).toEqual([]);
    expect((await driveAll({ ladderPolicy: POLICY })).harness).toEqual([]);
  });
});

describe('the dated settlement job', () => {
  type ScanInput = {
    settlementFixingConfigured: string;
    ownerSettlementPriceFor: unknown;
    lastTradePrice: unknown;
    markPrice: unknown;
    ledger: unknown;
  };
  const scanOf = async (extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) =>
    (await driveAll(extra, config)).inputs.find((r) => r.tick === 'runDatedFuturesSettlementScan')!.input as ScanInput;

  it('runs the scan with the config’s fixing stamp, blank when the owner named none', async () => {
    expect((await scanOf()).settlementFixingConfigured).toBe('');
    expect((await scanOf({}, { settlementFixing: 'owner-stamp' })).settlementFixingConfigured).toBe('owner-stamp');
  });

  it('never turns the last trade or the mark into the owner’s settlement price', async () => {
    const lastTradePrice = async () => '1';
    const markPrice = async () => '2';
    const scan = await scanOf({ lastTradePrice, markPrice }, { settlementFixing: 'owner-stamp' });
    expect(scan.ownerSettlementPriceFor).toBeUndefined();
    expect(scan.lastTradePrice).toBe(lastTradePrice);
    expect(scan.markPrice).toBe(markPrice);
    // Nothing named: none is invented.
    const bare = await scanOf();
    expect(bare.ownerSettlementPriceFor).toBeUndefined();
    expect(bare.lastTradePrice).toBeNull();
    expect(bare.markPrice).toBeNull();
    // Only the owner's own price reaches the scan as the settlement price.
    const owner = async () => '3';
    expect((await scanOf({ ownerSettlementPriceFor: owner, lastTradePrice, markPrice })).ownerSettlementPriceFor).toBe(owner);
  });
});
