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

import { describe, expect, it } from 'vitest';
import { presentFuturesJobsHealth } from './futures-jobs-health.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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
});

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const src = readFileSync(join(here, 'futures-jobs-health.ts'), 'utf8');

  it('presenter has no maintenanceBps, ladder, or 8h interval echo (kept source pin)', () => {
    expect(src).not.toMatch(/maintenanceBps/);
    expect(src).not.toMatch(/DEFAULT_FUTURES_LADDER_POLICY/);
    expect(src).not.toMatch(/28_?800_?000|28800000/);
    expect(src).toMatch(/fundingIntervalConfigured/);
  });
});
