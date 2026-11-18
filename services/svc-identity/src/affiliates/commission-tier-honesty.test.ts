import { describe, expect, it } from 'vitest';
import type { TierRate } from './commission.js';
import {
  defaultTierCatalogBoardCard,
  defaultTierCatalogStatusLine,
  parseDefaultTierCatalogStatusLine,
  defaultTierCatalogStatusLineMatches,
  defaultTierCatalogStatusLineConsistent,
  defaultTierCatalogExportHeader,
  defaultTierCatalogExportLines,
  defaultTierCatalogExportText,
  isDecimalRateString,
  defaultTierRatesAreDecimalStrings,
} from './commission-tier-honesty.js';

/** Test fixture only — not a production default. */
const FIXTURE_TIERS: readonly TierRate[] = [
  { hop: 0, rate: '0.130' },
  { hop: 1, rate: '0.07' },
  { hop: 2, rate: '0.03' },
];

describe('L3 wave113 commission tier catalog honesty', () => {
  it('boards only over supplied tiers (no invent default)', () => {
    expect(defaultTierCatalogBoardCard([])).toEqual({
      tiers: 0,
      minHop: -1,
      maxHop: -1,
      hasHop0: 0,
    });
    expect(defaultTierCatalogBoardCard(FIXTURE_TIERS)).toEqual({
      tiers: 3,
      minHop: 0,
      maxHop: 2,
      hasHop0: 1,
    });
    expect(defaultTierCatalogStatusLine(FIXTURE_TIERS)).toBe('tiers=3 min_hop=0 max_hop=2 hop0=1');
    expect(defaultTierCatalogStatusLineMatches(FIXTURE_TIERS)).toBe(true);
    expect(defaultTierCatalogStatusLineConsistent(defaultTierCatalogStatusLine(FIXTURE_TIERS))).toBe(true);
    expect(defaultTierCatalogExportText(FIXTURE_TIERS).startsWith(defaultTierCatalogExportHeader())).toBe(true);
    expect(defaultTierCatalogExportLines(FIXTURE_TIERS)).toEqual(['0,0.130', '1,0.07', '2,0.03']);
    expect(defaultTierRatesAreDecimalStrings(FIXTURE_TIERS)).toBe(true);
    expect(isDecimalRateString('0.130')).toBe(true);
    expect(isDecimalRateString('1.5')).toBe(false);
    expect(parseDefaultTierCatalogStatusLine('nope')).toBeNull();
  });
});
