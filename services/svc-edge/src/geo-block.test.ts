import { describe, expect, it } from 'vitest';
import { parseScreeningList, UNSET_SCREENING_LIST } from '@intafaced/config';
import {
  evaluateGeoBlock,
  GEO_BLOCK_EMPTY_CODE,
  GEO_BLOCK_HIT_CODE,
  GEO_BLOCK_REGION_UNKNOWN_CODE,
  GEO_BLOCK_SCREENED_CODE,
  GEO_BLOCK_UNRESOLVED_CODE,
  GEO_BLOCK_UNSET_CODE,
  inventedBlockedTrueList,
  looksLikeGeoClearance,
} from './geo-block.js';

/** Placeholder codes only — not a counsel sanctions list. */
const LISTED = parseScreeningList('AA:test-fixture-not-a-real-list', 'test-fixture-not-a-real-list');
const REVIEWED_EMPTY = parseScreeningList('none', 'counsel-memo-test-not-a-real-list');

describe('evaluateGeoBlock — empty is unknown, not a geo-clearance', () => {
  it('refuses unset screening with a typed code — not allowed', () => {
    const result = evaluateGeoBlock({ region: 'DE', screening: UNSET_SCREENING_LIST });
    expect(result).toMatchObject({
      allowed: false,
      code: GEO_BLOCK_UNSET_CODE,
      reason: 'screening_unset',
      screeningConfigured: false,
      screeningDeclaration: 'unset',
      inventedBlockedList: false,
    });
    expect(result).not.toHaveProperty('blocked');
    expect(looksLikeGeoClearance(result)).toBe(false);
    expect(inventedBlockedTrueList(result)).toBe(false);
  });

  it('refuses reviewed-empty — zero regions is not a green tick', () => {
    const result = evaluateGeoBlock({ region: 'DE', screening: REVIEWED_EMPTY });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe(GEO_BLOCK_EMPTY_CODE);
    expect(result.reason).toBe('screening_empty');
    expect(looksLikeGeoClearance(result)).toBe(false);
  });

  it('fails if empty screening is dressed as a geo-clearance', () => {
    const forged = {
      allowed: true,
      code: GEO_BLOCK_SCREENED_CODE,
      screeningConfigured: false,
      screeningDeclaration: 'unset',
    };
    expect(looksLikeGeoClearance(forged)).toBe(true);
    expect(
      looksLikeGeoClearance({
        allowed: true,
        blocked: false,
        screeningDeclaration: 'reviewed-empty',
        screeningConfigured: true,
      }),
    ).toBe(true);
  });

  it('a listed hit refuses from counsel content — never an invented blocked:true list', () => {
    const result = evaluateGeoBlock({ region: 'AA', screening: LISTED });
    expect(result).toMatchObject({
      allowed: false,
      code: GEO_BLOCK_HIT_CODE,
      reason: 'region_listed',
      listHitCount: 1,
      inventedBlockedList: false,
    });
    expect(result).not.toHaveProperty('blocked');
    expect(JSON.stringify(result)).not.toMatch(/"blocked"\s*:\s*true/);
    expect(inventedBlockedTrueList(result)).toBe(false);
  });

  it('a listed miss is a real screen, not a default clearance from silence', () => {
    const result = evaluateGeoBlock({ region: 'DE', screening: LISTED });
    expect(result).toMatchObject({
      allowed: true,
      code: GEO_BLOCK_SCREENED_CODE,
      screeningDeclaration: 'listed',
      screeningConfigured: true,
      listHitCount: 0,
      regionResolved: true,
    });
    expect(looksLikeGeoClearance(result)).toBe(false);
  });

  it('does not paint unresolved XX as geo-screened when a list exists (fail-open)', () => {
    const result = evaluateGeoBlock({ region: 'XX', screening: LISTED });
    expect(result).toMatchObject({
      allowed: true,
      code: GEO_BLOCK_UNRESOLVED_CODE,
      reason: 'region_unresolved',
      regionResolved: false,
      screeningDeclaration: 'listed',
      inventedBlockedList: false,
    });
    expect(result.code).not.toBe(GEO_BLOCK_SCREENED_CODE);
    expect(looksLikeGeoClearance(result)).toBe(false);
    expect(
      looksLikeGeoClearance({
        allowed: true,
        code: GEO_BLOCK_SCREENED_CODE,
        reason: 'region_not_listed',
        regionResolved: false,
        screeningDeclaration: 'listed',
        screeningConfigured: true,
      }),
    ).toBe(true);
  });

  it('refuses unresolved XX when region fail-closed is armed — still not a screen', () => {
    const result = evaluateGeoBlock({ region: 'XX', screening: LISTED, regionFailClosed: true });
    expect(result).toMatchObject({
      allowed: false,
      code: GEO_BLOCK_REGION_UNKNOWN_CODE,
      reason: 'region_unknown',
      regionResolved: false,
      inventedBlockedList: false,
    });
    expect(looksLikeGeoClearance(result)).toBe(false);
  });

  it('does not invent JURISDICTION_MATRIX blocked:true for a region the shipped matrix does not block', () => {
    const result = evaluateGeoBlock({ region: 'CA', screening: LISTED });
    expect(JSON.stringify(result)).not.toMatch(/"blocked"\s*:\s*true/);
    expect(inventedBlockedTrueList({ blocked: true })).toBe(true);
    expect(inventedBlockedTrueList({ blocked: [{ region: 'XX', blocked: true }] })).toBe(true);
  });
});
