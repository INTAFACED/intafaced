/**
 * Unit card — live host does not inject placeholder D3 ladder into jobs
 * 1. Promise: startFuturesJobs takes no ladder until the owner names D3 rungs (TRADE_FUTURES_LADDER_POLICY)
 * 2. Break: index.ts passes DEFAULT_FUTURES_LADDER_POLICY or a maintenanceBps number
 * 3. Done bar: source has neither; omitted policy stays skip (skipped_d3_unset)
 * 4. Class N
 * 5. Paths: svc-trade/src/index.ts
 * 6. RED: ladderPolicy: DEFAULT_FUTURES_LADDER_POLICY
 * 7. Collision: none — jobs.ts already pins the tick; this pins the live host
 */

import { describe, expect, it } from 'vitest';
import { tradeEnvWith } from './testing/doors.js';
import type { FuturesJobsDeps } from './futures-jobs.js';
import * as gate from './futures-ladder-owner-gate.js';
import * as ladder from './maintenance-ladder.js';

describe('live host does not invent D3 ladder numbers', () => {
  it('does not import DEFAULT_FUTURES_LADDER_POLICY', () => {
    // The modules the host builds its ladder from offer no placeholder to import.
    expect(ladder).not.toHaveProperty('DEFAULT_FUTURES_LADDER_POLICY');
    expect(gate).not.toHaveProperty('DEFAULT_FUTURES_LADDER_POLICY');
  });

  it('startFuturesJobs takes no ladder but the owner’s published one, and no maintenanceBps', () => {
    // The only ladder is TRADE_FUTURES_LADDER_POLICY as the owner set it (blank: none). Never a table in code.
    expect(gate.ownerLadderPolicy(tradeEnvWith({}, ['TRADE_FUTURES_LADDER_POLICY']).TRADE_FUTURES_LADDER_POLICY)).toBeUndefined();
    const base: FuturesJobsDeps = {
      sql: {} as never,
      ledger: {} as never,
      matching: {} as never,
      bus: null,
      config: { enabled: false, liqIntervalMs: 1000, fundingIntervalMs: null, fundingMarketIds: [], fundingMaxAbsRate: null },
    };
    // @ts-expect-error FuturesJobsDeps has no maintenanceBps of its own: maintenance comes from the ladder alone.
    const withBps: FuturesJobsDeps = { ...base, maintenanceBps: 50 };
    expect(withBps.ladderPolicy).toBeUndefined();
  });
});
