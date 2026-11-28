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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const indexSource = readFileSync(join(here, '..', 'index.ts'), 'utf8');

  it('does not import DEFAULT_FUTURES_LADDER_POLICY (kept source pin)', () => {
    expect(indexSource).not.toMatch(/DEFAULT_FUTURES_LADDER_POLICY/);
  });

  it('startFuturesJobs takes no ladder but the owner\u2019s published one, and no maintenanceBps (kept source pin)', () => {
    expect(indexSource).toMatch(/startFuturesJobs\(/);
    // The only ladder is TRADE_FUTURES_LADDER_POLICY as the owner set it (blank: none). Never a table in code.
    const ladders = [...indexSource.matchAll(/ladderPolicy:\s*([^\n]+)/g)].map((m) => m[1]!.trim());
    // index.ts sets no ladder itself: it hands startFuturesJobs futuresJobsHostDeps's answer alone (the call-site pin in
    // dated-futures-settlement-jobhost.money), and that answer's ladder is ownerLadderPolicy of the env, by behaviour, in
    // futures-ladder-default-not-production.test.ts.
    expect(ladders).toEqual([]);
    expect(indexSource).not.toMatch(/startFuturesJobs\([\s\S]{0,1500}maintenanceBps:/);
  });
});
