/**
 * Unit card — jobs assembly does not fall back to placeholder D3 rungs
 * 1. Promise: ladder.policy is deps.ladderPolicy only — omitted stays skip
 * 2. Break: policy: deps.ladderPolicy ?? DEFAULT_FUTURES_LADDER_POLICY
 * 3. Done bar: the ladder the jobs hold and hand the tick is the one passed in, or none
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/futures-jobs.ts
 * 6. RED: policy: deps.ladderPolicy ?? DEFAULT_FUTURES_LADDER_POLICY
 * 7. Collision: none — futures-jobs-tick-wiring.test.ts reads the tick's input; this reads the ladder gate
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';

const POLICY: FuturesLadderPolicy = {
  tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 300 }],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 10_000,
};

afterEach(() => {
  vi.doUnmock('./ladder-policy.test-harness.js');
  vi.resetModules();
});

/** Fresh-import the jobs with the test-only ladder table watched, and start them with `ladderPolicy` (or none). */
async function start(ladderPolicy?: FuturesLadderPolicy, enabled = false) {
  const loads: string[] = [];
  vi.resetModules();
  vi.doMock('./ladder-policy.test-harness.js', async (importOriginal) => {
    loads.push('harness');
    return importOriginal();
  });
  const { startFuturesJobs } = await import('./futures-jobs.js');
  const handle = startFuturesJobs({
    sql: (() => Promise.resolve([])) as never,
    ledger: { post: vi.fn(), balance: vi.fn() },
    matching: { depth: vi.fn(async () => ({ bids: [], asks: [], sequence: 0 })) } as never,
    bus: null,
    setIntervalFn: (() => 0) as never,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    ...(ladderPolicy ? { ladderPolicy } : {}),
    config: { enabled, liqIntervalMs: 1000, fundingIntervalMs: null, fundingMarketIds: [], fundingMaxAbsRate: null },
  });
  handle.stop();
  return { handle, loads };
}

describe('futures jobs do not coalesce omitted D3 into DEFAULT rungs', () => {
  it('passes deps.ladderPolicy through with no fallback', async () => {
    for (const enabled of [false, true]) {
      expect((await start(undefined, enabled)).handle.ladderGate.policy).toBeUndefined();
      expect((await start(POLICY, enabled)).handle.ladderGate.policy).toBe(POLICY);
    }
  });

  it('does not mention DEFAULT_FUTURES_LADDER_POLICY', async () => {
    // The jobs never load the only module that holds the placeholder table, with or without a ladder.
    for (const policy of [undefined, POLICY]) {
      for (const enabled of [false, true]) expect((await start(policy, enabled)).loads).toEqual([]);
    }
  });
});
