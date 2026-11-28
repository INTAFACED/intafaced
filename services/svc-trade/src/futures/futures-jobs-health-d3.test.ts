/**
 * Unit card — /health futuresJobs does not echo D3 ladder numbers
 * 1. Promise: occupancy booleans only; no maintenanceBps / rung table
 * 2. Break: presentFuturesJobsHealth adds maintenanceBps from DEFAULT policy
 * 3. Done bar: type and presenter have no maintenanceBps, no ladder, no 8h
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/futures-jobs-health.ts
 * 6. RED: maintenanceBps: in the presenter return
 * 7. Collision: #1918 host D3 pin (index.ts) — this file does not read index.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { presentFuturesJobsHealth } from './futures-jobs-health.js';

describe('/health futuresJobs does not invent D3', () => {
  it('presenter has no maintenanceBps, ladder, or 8h interval echo', () => {
    const health = presentFuturesJobsHealth({
      enabled: true,
      fundingMarketCount: 2,
      fundingMaxAbsRateConfigured: true,
      fundingIntervalConfigured: true,
      venueMarkConfigured: true,
    });
    // Occupancy booleans and a count only: the interval is a yes/no, never its milliseconds.
    expect(health.fundingIntervalConfigured).toBe(true);
    expect(health.fundingIntervalDefault).toBe(false);
    expect(health).not.toHaveProperty('maintenanceBps');
    expect(JSON.stringify(health)).not.toMatch(/maintenanceBps|tiers|uptoDepthBps|28_?800_?000/);
    const smuggled = presentFuturesJobsHealth({
      enabled: true,
      fundingMarketCount: 1,
      fundingMaxAbsRateConfigured: true,
      // @ts-expect-error presentFuturesJobsHealth takes no interval in ms
      fundingIntervalMs: 28_800_000,
    });
    expect(JSON.stringify(smuggled)).not.toMatch(/28800000/);
  });

  it('no export of futures-jobs-health carries a maintenance number, a ladder or an interval, on any input', async () => {
    const loads: string[] = [];
    vi.resetModules();
    vi.doMock('./ladder-policy.test-harness.js', async (importOriginal) => {
      loads.push('harness');
      return importOriginal();
    });
    try {
      const health = await import('./futures-jobs-health.js');
      expect(Object.keys(health).sort()).toEqual(['LIQUIDATION_NOT_SCHEDULED', 'liquidationJobAlerts', 'presentFuturesJobsHealth']);
      const answers: unknown[] = [health.LIQUIDATION_NOT_SCHEDULED, health.liquidationJobAlerts(true), health.liquidationJobAlerts(false)];
      for (const enabled of [true, false]) {
        for (const count of [0, 1, 3]) {
          for (const flag of [true, false, undefined]) {
            const answer = health.presentFuturesJobsHealth({
              enabled,
              fundingMarketCount: count,
              fundingMaxAbsRateConfigured: flag === true,
              fundingIntervalConfigured: flag,
              venueMarkConfigured: flag,
            });
            expect(answer.fundingIntervalConfigured).toBe(flag === true);
            answers.push(answer);
          }
        }
      }
      for (const answer of answers)
        expect(JSON.stringify(answer)).not.toMatch(/maintenanceBps|uptoDepthBps|tiers"|28_?800_?000|intervalMs/);
      expect(loads).toEqual([]);
    } finally {
      vi.doUnmock('./ladder-policy.test-harness.js');
      vi.resetModules();
    }
  });
});
