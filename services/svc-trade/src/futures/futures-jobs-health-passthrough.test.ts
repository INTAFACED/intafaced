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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const indexSource = readFileSync(join(here, '..', 'index.ts'), 'utf8');

  it('live host mounts presentFuturesJobsHealth on /health (kept source pin)', () => {
    expect(indexSource).toMatch(/futuresJobs:\s*presentFuturesJobsHealth\(/);
    expect(indexSource).toMatch(/enabled:\s*env\.TRADE_FUTURES_JOBS_ENABLED/);
    expect(indexSource).toMatch(/fundingMarketCount:\s*fundingMarketIds\.length/);
    expect(indexSource).toMatch(/fundingMaxAbsRateConfigured:\s*fundingMaxAbsRate\s*!==\s*null/);
    expect(indexSource).toMatch(/fundingIntervalConfigured:\s*env\.TRADE_FUTURES_FUNDING_INTERVAL_MS\s*!=\s*null/);
    expect(indexSource).toMatch(/venueMarkConfigured:\s*venueMarkConfigured\s*!=\s*null/);
  });

  it('does not put the |rate| decimal or market UUID list on /health (kept source pin)', () => {
    const health = /app\.get\('\/health'[\s\S]*?\n\}\)\);/.exec(indexSource)?.[0] ?? '';
    expect(health).toContain('presentFuturesJobsHealth');
    expect(health).not.toMatch(/fundingMaxAbsRate:\s*fundingMaxAbsRate/);
    expect(health).not.toMatch(/fundingMarketIds:/);
    expect(health).not.toMatch(/venueId:/);
    expect(health).not.toMatch(/TRADE_FUTURES_FUNDING_INTERVAL_MS:/);
    expect(health).not.toMatch(/28_?800_?000/);
  });

  it('boot log does not echo TRADE_VENUE_MARK_VENUE (kept source pin)', () => {
    expect(indexSource).toMatch(/venueMark:\s*venueMarkConfigured \? \{ configured: true, symbolCount:/);
    expect(indexSource).not.toMatch(/venueId:\s*venueMarkConfigured\.venueId/);
  });
});
