/**
 * Unit card — consolidated trade.futures policy honesty door
 * 1. Promise: jobs defaults off, insurance empty blocks list, ADL copy without invented thresholds
 * 2. Break: describeFuturesPolicy omits insurance or ADL law
 * 3. Done bar: router mounts futures.policy → describeFuturesPolicy({})
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/futures-policy.ts, router.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADL_DISCLOSURE_COPY,
  ADL_DISCLOSURE_VERSION,
  describeFuturesPolicy,
  presentFuturesJobsCapabilityNote,
  presentInsuranceListingPolicy,
} from './futures-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const routerSource = readFileSync(join(here, '..', 'router.ts'), 'utf8');

describe('describeFuturesPolicy — trade.futures honesty door', () => {
  it('combines jobs capability, insurance listing, and ADL disclosure constants', () => {
    const policy = describeFuturesPolicy({});
    expect(policy.jobs).toEqual(presentFuturesJobsCapabilityNote({}));
    expect(policy.insuranceListing).toEqual(presentInsuranceListingPolicy());
    expect(policy.adlDisclosure.version).toBe(ADL_DISCLOSURE_VERSION);
    expect(policy.adlDisclosure).not.toHaveProperty('requiredCode');
    expect(policy.adlDisclosure.copy).toBe(ADL_DISCLOSURE_COPY);
    expect(policy.adlDisclosure.inventsThresholds).toBe(false);
    expect(policy.adlDisclosure.inventsRanking).toBe(false);
    expect(policy.datedFutures.inventsLastTradeSettlement).toBe(false);
    expect(policy.datedFutures.infersStyleFromSymbol).toBe(false);
    expect(policy.datedFutures.expiryRequiredCode).toBe('trade.dated_futures_expiry_required');
    expect(policy.datedFutures.settlementPriceUnsetCode).toBe('trade.dated_futures_settlement_price_unset');
    expect(ADL_DISCLOSURE_COPY.toLowerCase()).toContain('last-resort');
    expect(ADL_DISCLOSURE_COPY).not.toMatch(/\d+\s*%/);
  });

  it('reflects explicit jobs flags when provided', () => {
    const policy = describeFuturesPolicy({ jobsEnabled: true, orderableEnabled: true, fundingMarketCount: 3 });
    expect(policy.jobs.jobsEnabled).toBe(true);
    expect(policy.jobs.orderableEnabled).toBe(true);
    expect(policy.jobs.fundingMarketCount).toBe(3);
    expect(policy.jobs.ladderNumbers).toBe('d3_unset');
    expect(JSON.stringify(policy.jobs)).not.toMatch(/venueId|symbols/);
  });
});

describe('futures.policy route (trade.futures honesty door)', () => {
  it('router mounts describeFuturesPolicy on futures.policy', () => {
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*describeFuturesPolicy\(\{\}\)\)/);
  });
});
