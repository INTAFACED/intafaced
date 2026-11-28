/**
 * Unit card — live host passes futures flags into capabilities
 * 1. Promise: GET /capabilities notes.futures follows TRADE_FUTURES_* env
 * 2. Break: registerPublicRest omits orderableEnabled; listed perps look live
 * 3. Done bar: index.ts passes jobs + orderable from env; nextFunding stays unpublished null
 * 4. Class N
 * 5. Paths: svc-trade/src/index.ts
 * 6. RED: no orderableEnabled: env.TRADE_FUTURES_ENABLED
 * 7. Collision: none
 */

import { describe, expect, it } from 'vitest';
import { publicRestDoor } from './testing/doors.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

async function capabilitiesFutures(futures?: NonNullable<Parameters<typeof publicRestDoor>[0]>['futures']) {
  const app = await publicRestDoor(futures ? { futures } : {});
  const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
  await app.close();
  expect(res.statusCode).toBe(200);
  return (res.json() as { notes: { futures: Record<string, unknown> } }).notes.futures;
}

describe('futures env passthrough into registerPublicRest', () => {
  it('live host passes TRADE_FUTURES_JOBS_ENABLED and TRADE_FUTURES_ENABLED', async () => {
    // Nothing passed: every flag reads off, as shipped.
    expect(await capabilitiesFutures()).toMatchObject({
      jobsEnabled: false,
      orderableEnabled: false,
      profitSourceConfigured: false,
      fundingMaxAbsRateConfigured: false,
      fundingMarketCount: 0,
      venueMarkConfigured: false,
      fundingIntervalConfigured: false,
    });
    // The host's flags reach GET /capabilities as yes/no and a count, never the ids, the rate or the interval.
    const note = await capabilitiesFutures({
      jobsEnabled: true,
      orderableEnabled: true,
      profitSourceConfigured: true,
      fundingMaxAbsRateConfigured: true,
      fundingMarketCount: 2,
      venueMarkConfigured: true,
      fundingIntervalConfigured: true,
    });
    expect(note).toMatchObject({
      jobsEnabled: true,
      orderableEnabled: true,
      profitSourceConfigured: true,
      fundingMaxAbsRateConfigured: true,
      fundingMarketCount: 2,
      venueMarkConfigured: true,
      fundingIntervalConfigured: true,
    });
    expect(note).not.toHaveProperty('fundingMarketIds');
    expect(note).not.toHaveProperty('fundingMaxAbsRate');
    expect(note).not.toHaveProperty('fundingIntervalMs');
  });

  it('published funding quote never invents nextFundingTimestamp from the 8h interval', async () => {
    const note = await capabilitiesFutures({ jobsEnabled: true, fundingIntervalConfigured: true, fundingMarketCount: 1 });
    expect(note.nextFundingTimestamp).toBe('unpublished');
    expect(note.indexPrice).toBe('unpublished');
  });
});

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const indexSource = readFileSync(join(here, '..', 'index.ts'), 'utf8');

  it('live host passes TRADE_FUTURES_JOBS_ENABLED and TRADE_FUTURES_ENABLED (kept source pin)', () => {
    expect(indexSource).toMatch(/futures:\s*\{[\s\S]*jobsEnabled:\s*env\.TRADE_FUTURES_JOBS_ENABLED/);
    expect(indexSource).toMatch(/futures:\s*\{[\s\S]*profitSourceConfigured:\s*profitSource != null/);
    expect(indexSource).toMatch(
      /futures:\s*\{[\s\S]*fundingMaxAbsRateConfigured:\s*env\.TRADE_FUTURES_FUNDING_MAX_ABS_RATE\.trim\(\) !== ''/,
    );
    expect(indexSource).toMatch(/futures:\s*\{[\s\S]*fundingMarketCount:\s*fundingMarketIds\.length/);
    expect(indexSource).toMatch(/futures:\s*\{[\s\S]*venueMarkConfigured:\s*venueMarkConfigured != null/);
    expect(indexSource).toMatch(/futures:\s*\{[\s\S]*fundingIntervalConfigured:\s*env\.TRADE_FUTURES_FUNDING_INTERVAL_MS != null/);
    expect(indexSource).not.toMatch(/fundingMarketIds:\s*fundingMarketIds/);
    expect(indexSource).not.toMatch(/fundingMaxAbsRate:\s*env\.TRADE_FUTURES_FUNDING_MAX_ABS_RATE/);
    expect(indexSource).not.toMatch(/futures:\s*\{[\s\S]*fundingIntervalMs:/);
  });

  it('published funding quote never invents nextFundingTimestamp from the 8h interval (kept source pin)', () => {
    expect(indexSource).toMatch(/nextFundingTimestamp:\s*null/);
    expect(indexSource).not.toMatch(/TRADE_FUTURES_FUNDING_INTERVAL_MS[\s\S]{0,200}nextFundingTimestamp/);
  });
});
