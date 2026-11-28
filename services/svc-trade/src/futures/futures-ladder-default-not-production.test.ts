/**
 * Unit card — production ladder module does not ship invented D3 rungs
 * 1. Promise: maintenance-ladder.ts has no DEFAULT_FUTURES_LADDER_POLICY table
 * 2. Break: export const DEFAULT_FUTURES_LADDER_POLICY with placeholder tiers
 * 3. Done bar: constant lives only in ladder-policy.test-harness.ts; live jobs still omit policy
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/maintenance-ladder.ts
 * 6. RED: export const DEFAULT_FUTURES_LADDER_POLICY
 * 7. Collision: none — no open svc-trade PRs
 */

import { describe, expect, it } from 'vitest';
import { tradeEnvWith } from './testing/doors.js';
import { ownerLadderPolicy } from './futures-ladder-owner-gate.js';
import { futuresJobsHostDeps } from './futures-jobs-host.js';
import * as harness from './ladder-policy.test-harness.js';
import * as production from './maintenance-ladder.js';

/** Every value a module exports, and every value nested inside them, flattened. */
function exportedValues(mod: object): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown, depth: number) => {
    out.push(v);
    if (depth > 4 || v === null || typeof v !== 'object') return;
    for (const inner of Object.values(v)) walk(inner, depth + 1);
  };
  for (const v of Object.values(mod)) walk(v, 0);
  return out;
}

describe('production ladder module does not ship invented D3 rungs', () => {
  it('futuresJobsHostDeps hands the jobs no ladder when unset and exactly the owner’s published one when set', () => {
    const parts = {
      sql: {} as never,
      ledger: {} as never,
      matching: {} as never,
      bus: null,
      liquidationFeeFraction: null,
      fundingMarketIds: [],
      fundingMaxAbsRate: null,
    };
    expect(futuresJobsHostDeps(tradeEnvWith({}, ['TRADE_FUTURES_LADDER_POLICY']), parts).ladderPolicy).toBeUndefined();
    const published = JSON.stringify(harness.DEFAULT_FUTURES_LADDER_POLICY);
    expect(futuresJobsHostDeps(tradeEnvWith({ TRADE_FUTURES_LADDER_POLICY: published }), parts).ladderPolicy).toEqual(
      ownerLadderPolicy(published),
    );
  });

  it('does not export DEFAULT_FUTURES_LADDER_POLICY', () => {
    expect(production).not.toHaveProperty('DEFAULT_FUTURES_LADDER_POLICY');
  });

  it('does not embed the placeholder depth-tier table', () => {
    const placeholder = harness.DEFAULT_FUTURES_LADDER_POLICY;
    for (const value of exportedValues(production)) {
      expect(value).not.toEqual(placeholder);
      expect(value).not.toEqual(placeholder.tiers);
      expect(value).not.toEqual(placeholder.tiers[0]);
    }
  });

  it('keeps the placeholder only in the test harness', () => {
    expect(harness.DEFAULT_FUTURES_LADDER_POLICY.tiers[0]).toEqual({ uptoDepthBps: 500, maintenanceBps: 50 });
  });

  it('live host passes no ladder but the owner’s published setting', () => {
    // The host's ladder is ownerLadderPolicy of its env: unset is no ladder at all, never the placeholder.
    const unset = tradeEnvWith({}, ['TRADE_FUTURES_LADDER_POLICY']).TRADE_FUTURES_LADDER_POLICY;
    expect(unset).toBe('');
    expect(ownerLadderPolicy(unset)).toBeUndefined();
    const published = JSON.stringify(harness.DEFAULT_FUTURES_LADDER_POLICY);
    expect(ownerLadderPolicy(tradeEnvWith({ TRADE_FUTURES_LADDER_POLICY: published }).TRADE_FUTURES_LADDER_POLICY)).toEqual(
      harness.DEFAULT_FUTURES_LADDER_POLICY,
    );
  });
});
