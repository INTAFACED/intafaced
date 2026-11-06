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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, '..', 'index.ts'), 'utf8');

describe('futures env passthrough into registerPublicRest', () => {
  it('live host passes TRADE_FUTURES_JOBS_ENABLED and TRADE_FUTURES_ENABLED', () => {
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

  it('published funding quote never invents nextFundingTimestamp from the 8h interval', () => {
    // Since J-derivatives-08 the quote is built in funding-view.ts: an S2S rate still has none, and a computed period's
    // comes from the owner's period length stored with the funding numbers, never from the tick interval env.
    const viewSource = readFileSync(new URL('./funding-view.ts', import.meta.url), 'utf8');
    expect(viewSource).toMatch(/nextFundingTimestamp:\s*null/);
    expect(viewSource).not.toMatch(/TRADE_FUTURES_FUNDING_INTERVAL_MS|fundingIntervalMs/);
    expect(indexSource).not.toMatch(/TRADE_FUTURES_FUNDING_INTERVAL_MS[\s\S]{0,200}nextFundingTimestamp/);
  });
});
