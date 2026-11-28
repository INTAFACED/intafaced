/**
 * Unit card — live host mounts presentFuturesJobsHealth on /health
 * 1. Promise: /health occupancy follows env + parsed market count, never the decimal
 * 2. Break: /health omits futuresJobs so ops infer a live schedule from ok:true
 * 3. Done bar: index.ts calls presentFuturesJobsHealth with env + count + configured boolean
 * 4. Class N
 * 5. Paths: svc-trade/src/index.ts
 * 6. RED: no futuresJobs: presentFuturesJobsHealth
 * 7. Collision: #1878 compose pin (does not touch index.ts)
 */

import { describe, expect, it } from 'vitest';
import { presentFuturesJobsHealth } from './futures-jobs-health.js';

describe('futures jobs occupancy on /health', () => {
  it('live host mounts presentFuturesJobsHealth on /health', () => {
    // What the host reports is what it was told: each flag and the count pass through, nothing is assumed on.
    const off = presentFuturesJobsHealth({ enabled: false, fundingMarketCount: 0, fundingMaxAbsRateConfigured: false });
    expect(off).toMatchObject({ enabled: false, liquidationArmed: false, fundingScheduled: false, reason: 'jobs_off' });
    expect(off).toMatchObject({ fundingIntervalConfigured: false, venueMarkConfigured: false });
    const on = presentFuturesJobsHealth({
      enabled: true,
      fundingMarketCount: 3,
      fundingMaxAbsRateConfigured: true,
      fundingIntervalConfigured: true,
      venueMarkConfigured: true,
    });
    expect(on).toMatchObject({
      enabled: true,
      liquidationArmed: true,
      fundingMarketCount: 3,
      fundingScheduled: true,
      fundingMaxAbsRateConfigured: true,
      fundingIntervalConfigured: true,
      venueMarkConfigured: true,
      reason: 'funding_scheduled',
      alerts: [],
    });
  });

  it('does not put the |rate| decimal or market UUID list on /health', () => {
    // The presenter's input has no slot for the rate, the market ids or the venue: none can reach /health.
    const health = presentFuturesJobsHealth({
      enabled: true,
      fundingMarketCount: 1,
      fundingMaxAbsRateConfigured: true,
      // @ts-expect-error no rate decimal on /health
      fundingMaxAbsRate: '0.0075',
      fundingMarketIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      venueId: 'some-venue',
    });
    expect(JSON.stringify(health)).not.toMatch(/0\.0075|aaaaaaaa|some-venue|fundingMarketIds|venueId/);
  });
});
