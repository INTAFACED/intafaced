import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODULE_RULES,
  REGION_FAIL_CLOSED_ENV,
  SCREENING_FAIL_CLOSED_ENV,
  UNRESOLVED_REGION,
  assertReviewed,
  businessBlockFor,
  activeBusinessBlocks,
  businessBlocksFrom,
  checkAccess,
  testBusinessBlocksFromEnv,
  TEST_BUSINESS_BLOCK_REASON,
  TEST_BUSINESS_BLOCKS_ENV,
  isRegionBlocked,
  isRegionResolved,
  regionFailClosedFromEnv,
  ruleFor,
  screeningStatus,
  SHIPPED_BUSINESS_BLOCKS,
  UnreviewedJurisdictionError,
  tierSatisfies,
} from './jurisdiction.js';
import { MODULES } from './modules.js';
import { UNSET_SCREENING_LIST, type ScreeningList } from './screening.js';

/**
 * Unset screening refuses. These tests observe sovereignty and region rules,
 * so they pin the screening flag explicitly off. They do not supply a list.
 */
const screeningFailClosedAtLoad = process.env[SCREENING_FAIL_CLOSED_ENV];
const appEnvAtLoad = process.env.APP_ENV;
beforeEach(() => {
  process.env.APP_ENV = 'test';
  process.env[SCREENING_FAIL_CLOSED_ENV] = '0';
});
afterEach(() => {
  if (appEnvAtLoad === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = appEnvAtLoad;
  if (screeningFailClosedAtLoad === undefined) delete process.env[SCREENING_FAIL_CLOSED_ENV];
  else process.env[SCREENING_FAIL_CLOSED_ENV] = screeningFailClosedAtLoad;
});

describe('§22 sovereignty law — zero-KYC follows custody', () => {
  it('grants permissionless access to non-custodial protocol modules regardless of tier', () => {
    const d = checkAccess({ module: 'protocol', region: 'CA', plane: 'protocol', kycTier: 'none' });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe('allowed.permissionless');
    expect(d.regionResolved).toBe(true);
  });

  it('never lets a protocol-plane module demand KYC, for any region in the matrix', () => {
    const permissionless = Object.values(MODULES).filter((m) => !m.custodial && m.planes.includes('protocol'));
    for (const m of permissionless) {
      for (const region of ['US', 'GB', 'NG', 'ZZ']) {
        const d = checkAccess({ module: m.id, region, plane: 'protocol', kycTier: 'none' });
        expect(d.code, `${m.id} in ${region}`).not.toBe('denied.kyc_required');
      }
    }
  });

  it('gates custodial modules behind the matrix tier', () => {
    const d = checkAccess({ module: 'bank', region: 'DE', plane: 'fiat', kycTier: 'basic' });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('denied.kyc_required');
    expect(d.requiredTier).toBe('full');
    expect(d.regionResolved).toBe(true);
  });

  it('allows a custodial module once the tier is met', () => {
    const d = checkAccess({ module: 'bank', region: 'DE', plane: 'fiat', kycTier: 'full' });
    expect(d.allowed).toBe(true);
    expect(d.limitMultiplier).toBe(1);
  });

  // The US used to block `launch` and `bank` module by module. OWNER 237 (8 Nov 2026): "US block: the US is blocked
  // at launch as well as sanctioned countries, on the existing per-country switch." So the whole region refuses now,
  // before any module rule is read, and the refusal is the business's.
  it('refuses US launch on the per-country switch, ahead of any module rule (OWNER 237)', () => {
    const d = checkAccess({ module: 'launch', region: 'US', plane: 'fiat', kycTier: 'institutional' });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('denied.region_blocked');
    expect(d.blockedBy).toBe('business');
  });

  it('denies a plane the module does not operate on', () => {
    const d = checkAccess({ module: 'pay', region: 'DE', plane: 'protocol', kycTier: 'full' });
    expect(d.code).toBe('denied.plane_unsupported');
    expect(d.regionResolved).toBe(true);
  });

  it('the bridge is custodial and therefore always tiered', () => {
    expect(MODULES.bridge.custodial).toBe(true);
    const d = checkAccess({ module: 'bridge', region: 'DE', plane: 'protocol', kycTier: 'none' });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('denied.kyc_required');
  });
});

/**
 * THE GAP THIS CLOSES (region half).
 *
 * Screening already reports whether a *list* was consulted. The caller's
 * *region* had a second unknown: edge stamps DEFAULT_REGION='XX' on every
 * request, XX is not in the matrix, and checkAccess fell open on defaults —
 * while env comments claimed XX was "restrictive". Allowed decisions for XX
 * and for GB looked the same on the wire.
 *
 * regionResolved (always) + optional denied.region_unknown (fail-closed ON)
 * make the states different. Fail-closed defaults OFF so protocol boot's
 * sovereignty assert (region XX → allowed.permissionless) still holds.
 */
describe('unresolved region is distinguishable — and can fail closed', () => {
  const original = process.env[REGION_FAIL_CLOSED_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[REGION_FAIL_CLOSED_ENV];
    else process.env[REGION_FAIL_CLOSED_ENV] = original;
  });

  it('treats XX as the unresolved sentinel, case-insensitive', () => {
    expect(UNRESOLVED_REGION).toBe('XX');
    expect(isRegionResolved('XX')).toBe(false);
    expect(isRegionResolved('xx')).toBe(false);
    expect(isRegionResolved('GB')).toBe(true);
    expect(isRegionResolved('DE')).toBe(true);
  });

  it('treats empty, whitespace, and padded XX as unresolved and refuses them fail-closed', () => {
    const blanks = ['', ' ', '   ', '\t', ' xx ', ' XX ', 'Xx', ' xX '];
    const whitespaceList: ScreeningList = {
      configured: true,
      declaration: 'listed',
      source: 'test-fixture-not-a-real-list',
      regions: [
        {
          region: '   ',
          reason: 'blank is not a region code',
          source: 'test-fixture-not-a-real-list',
          authority: 'screening',
        },
        {
          region: ' XX ',
          reason: 'padded sentinel is not a region code',
          source: 'test-fixture-not-a-real-list',
          authority: 'screening',
        },
      ],
    };
    const whitespaceBlocks = businessBlocksFrom([
      { region: '   ', blocked: true, reason: 'blank is not a region code' },
      { region: ' XX ', blocked: true, reason: 'padded sentinel is not a region code' },
    ]);

    for (const region of blanks) {
      expect(isRegionResolved(region), JSON.stringify(region)).toBe(false);
      const refused = checkAccess({
        module: 'bank',
        plane: 'fiat',
        region,
        kycTier: 'full',
        regionFailClosed: true,
        screeningFailClosed: false,
        screening: whitespaceList,
        business: whitespaceBlocks,
      });
      expect(refused.allowed, JSON.stringify(region)).toBe(false);
      expect(refused.code, JSON.stringify(region)).toBe('denied.region_unknown');
      expect(refused.regionResolved, JSON.stringify(region)).toBe(false);
      expect(ruleFor('bank', region), JSON.stringify(region)).not.toEqual(DEFAULT_MODULE_RULES.bank);
      expect(ruleFor('dex', region).status, JSON.stringify(region)).not.toBe('open');
      expect(businessBlockFor(region, whitespaceBlocks), JSON.stringify(region)).toBeUndefined();
      expect(isRegionBlocked(region, whitespaceList, whitespaceBlocks), JSON.stringify(region)).toBe(false);
    }

    expect(isRegionResolved('GB')).toBe(true);
    expect(isRegionResolved('DE')).toBe(true);
    expect(isRegionResolved('US')).toBe(true);
    expect(ruleFor('trade', 'GB').status).toBe('restricted');
    expect(businessBlockFor('US')?.authority).toBe('business');
  });

  it('marks regionResolved false on an ALLOWED decision for XX (default fail-open)', () => {
    // Protocol boot invariant: unknown region still permissionless when the
    // fail-closed flag is off. What changed is the decision now *says* so.
    const d = checkAccess({
      module: 'protocol',
      plane: 'protocol',
      region: UNRESOLVED_REGION,
      kycTier: 'none',
      regionFailClosed: false,
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe('allowed.permissionless');
    expect(d.regionResolved).toBe(false);
  });

  it('marks regionResolved true for a real code even when that code has no matrix entry', () => {
    // No matrix entry ≠ unresolved. DE falls through to defaults, but we were
    // told the caller is in DE — that is a resolved claim, not the sentinel.
    const d = checkAccess({ module: 'protocol', plane: 'protocol', region: 'DE', kycTier: 'none' });
    expect(d.code).toBe('allowed.permissionless');
    expect(d.regionResolved).toBe(true);
  });

  it('refuses XX with denied.region_unknown when regionFailClosed is true', () => {
    const d = checkAccess({
      module: 'protocol',
      plane: 'protocol',
      region: UNRESOLVED_REGION,
      kycTier: 'none',
      regionFailClosed: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('denied.region_unknown');
    expect(d.regionResolved).toBe(false);
    expect(d.reason).toContain(REGION_FAIL_CLOSED_ENV);
  });

  it('does not refuse a resolved region under fail-closed', () => {
    const d = checkAccess({
      module: 'protocol',
      plane: 'protocol',
      region: 'GB',
      kycTier: 'none',
      regionFailClosed: true,
    });
    expect(d.code).toBe('allowed.permissionless');
    expect(d.regionResolved).toBe(true);
  });

  it('reads INTAFACED_REGION_FAIL_CLOSED from the environment when the query omits the flag', () => {
    expect(regionFailClosedFromEnv({})).toBe(false);
    expect(regionFailClosedFromEnv({ [REGION_FAIL_CLOSED_ENV]: 'true' })).toBe(true);
    expect(regionFailClosedFromEnv({ [REGION_FAIL_CLOSED_ENV]: '1' })).toBe(true);
    expect(regionFailClosedFromEnv({ [REGION_FAIL_CLOSED_ENV]: 'no' })).toBe(false);

    process.env[REGION_FAIL_CLOSED_ENV] = 'yes';
    const refused = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'xx',
      kycTier: 'none',
    });
    expect(refused.code).toBe('denied.region_unknown');

    // Explicit query flag wins over env — keeps sovereignty tests hermetic.
    const overridden = checkAccess({
      module: 'protocol',
      plane: 'protocol',
      region: UNRESOLVED_REGION,
      kycTier: 'none',
      regionFailClosed: false,
    });
    expect(overridden.code).toBe('allowed.permissionless');
    expect(overridden.regionResolved).toBe(false);
  });

  it('still surfaces plane_unsupported before region_unknown (module/plane is the denser fact)', () => {
    const d = checkAccess({
      module: 'pay',
      plane: 'protocol',
      region: UNRESOLVED_REGION,
      kycTier: 'full',
      regionFailClosed: true,
    });
    expect(d.code).toBe('denied.plane_unsupported');
    expect(d.regionResolved).toBe(false);
  });
});

describe('tier ordering', () => {
  it('is monotonic', () => {
    expect(tierSatisfies('full', 'basic')).toBe(true);
    expect(tierSatisfies('basic', 'full')).toBe(false);
    expect(tierSatisfies('institutional', 'institutional')).toBe(true);
    expect(tierSatisfies('none', 'none')).toBe(true);
  });
});

describe('counsel review gate', () => {
  it('refuses unreviewed launch markets', () => {
    expect(() => assertReviewed(['GB'])).toThrow(UnreviewedJurisdictionError);
  });

  it('names every unreviewed region so the operator fixes them in one pass', () => {
    try {
      assertReviewed(['GB', 'US']);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnreviewedJurisdictionError);
      expect((e as UnreviewedJurisdictionError).regions).toEqual(['GB', 'US']);
    }
  });
});

// LOCAL TEST only (J-wallet-09 #1): a test stack blocks the TEST region AA so a journey can play a visitor from a blocked
// region without the screening list. It goes through checkAccess's own region branch, so removing that branch fails here.
describe('TEST business blocks (INTAFACED_TEST_BUSINESS_BLOCKS)', () => {
  const LISTED_NONE: ScreeningList = { regions: [], declaration: 'reviewed-empty', configured: true, source: 'TEST fixture' };
  const saved = { blocks: process.env[TEST_BUSINESS_BLOCKS_ENV], appEnv: process.env.APP_ENV };
  afterEach(() => {
    for (const [k, v] of [
      [TEST_BUSINESS_BLOCKS_ENV, saved.blocks],
      ['APP_ENV', saved.appEnv],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('reads TEST:<user-assigned code> entries in dev or test only', () => {
    expect(testBusinessBlocksFromEnv({ APP_ENV: 'dev', [TEST_BUSINESS_BLOCKS_ENV]: 'TEST:AA, TEST:qm' })).toEqual([
      { region: 'AA', reason: TEST_BUSINESS_BLOCK_REASON, source: `TEST:${TEST_BUSINESS_BLOCKS_ENV}`, authority: 'business' },
      { region: 'QM', reason: TEST_BUSINESS_BLOCK_REASON, source: `TEST:${TEST_BUSINESS_BLOCKS_ENV}`, authority: 'business' },
    ]);
    for (const appEnv of ['prod', 'staging', undefined, 'DEV'])
      expect(testBusinessBlocksFromEnv({ APP_ENV: appEnv, [TEST_BUSINESS_BLOCKS_ENV]: 'TEST:AA' })).toEqual([]);
    expect(testBusinessBlocksFromEnv({ APP_ENV: 'dev' })).toEqual([]);
  });

  it('never blocks a real country: a code a country holds, or an unlabelled entry, throws', () => {
    for (const bad of ['TEST:US', 'TEST:XK', 'AA', 'TEST:AA:reason', 'TEST:AAA'])
      expect(() => testBusinessBlocksFromEnv({ APP_ENV: 'dev', [TEST_BUSINESS_BLOCKS_ENV]: bad })).toThrow(/value not shown/);
  });

  it('refuses a protocol-plane visitor from the TEST region with its reason, and serves everyone else', () => {
    process.env.APP_ENV = 'test';
    process.env[TEST_BUSINESS_BLOCKS_ENV] = 'TEST:AA';
    const q = { module: 'protocol', plane: 'protocol', kycTier: 'none', screening: LISTED_NONE, screeningFailClosed: false } as const;
    expect(checkAccess({ ...q, region: 'AA' })).toMatchObject({
      allowed: false,
      code: 'denied.region_blocked',
      reason: TEST_BUSINESS_BLOCK_REASON,
      blockedBy: 'business',
    });
    expect(isRegionBlocked('AA', LISTED_NONE)).toBe(true);
    expect(checkAccess({ ...q, region: 'DE' }).allowed).toBe(true);
    delete process.env[TEST_BUSINESS_BLOCKS_ENV];
    expect(checkAccess({ ...q, region: 'AA' }).allowed).toBe(true);
    expect(activeBusinessBlocks()).toEqual(SHIPPED_BUSINESS_BLOCKS);
    expect(activeBusinessBlocks().map((b) => b.region)).not.toContain('AA');
  });
});

/**
 * OWNER 237 (8 Nov 2026): "US block: the US is blocked at launch as well as sanctioned countries, on the existing
 * per-country switch." The switch is the matrix's `blocked: true`: it refuses the region on every module and every
 * plane, protocol included, and records the business as the authority, never screening.
 */
describe('the US is blocked at launch on the per-country switch (OWNER 237)', () => {
  const CLEAR: ScreeningList = { regions: [], declaration: 'reviewed-empty', configured: true, source: 'TEST fixture' };
  const everyModuleAndPlane = Object.values(MODULES).flatMap((m) => m.planes.map((plane) => ({ module: m.id, plane })));

  it('ships the US as a business block with a reason naming launch', () => {
    const us = businessBlockFor('US');
    expect(us).toMatchObject({ region: 'US', authority: 'business', reason: 'The United States is not served at launch.' });
    expect(us?.reason).toMatch(/launch/);
    expect(SHIPPED_BUSINESS_BLOCKS.map((b) => b.region)).toContain('US');
  });

  it('refuses the US denied.region_blocked on every module and plane, at every tier, blocked by the business', () => {
    expect(everyModuleAndPlane.some((q) => q.plane === 'protocol')).toBe(true);
    for (const q of everyModuleAndPlane) {
      for (const region of ['US', 'us', ' US ']) {
        for (const kycTier of ['none', 'institutional'] as const) {
          const d = checkAccess({ ...q, region, kycTier, screening: CLEAR, screeningFailClosed: false });
          const at = `${q.module}/${q.plane} ${JSON.stringify(region)} ${kycTier}`;
          expect(d.allowed, at).toBe(false);
          expect(d.code, at).toBe('denied.region_blocked');
          expect(d.blockedBy, at).toBe('business');
          expect(d.reason, at).toBe('The United States is not served at launch.');
          expect(d.limitMultiplier, at).toBe(0);
        }
      }
    }
    expect(isRegionBlocked('US', CLEAR)).toBe(true);
  });

  it('serves the neighbours: CA and MX are allowed on every module and plane', () => {
    for (const region of ['CA', 'MX']) {
      expect(businessBlockFor(region), region).toBeUndefined();
      expect(isRegionBlocked(region, CLEAR), region).toBe(false);
      for (const q of everyModuleAndPlane) {
        const d = checkAccess({ ...q, region, kycTier: 'institutional', screening: CLEAR, screeningFailClosed: false });
        expect(d.allowed, `${q.module}/${q.plane} ${region}`).toBe(true);
        expect(d.blockedBy, `${q.module}/${q.plane} ${region}`).toBeUndefined();
      }
    }
  });

  it('is a business block, so it never satisfies the sanctions screening guard', () => {
    const status = screeningStatus(UNSET_SCREENING_LIST);
    expect(status.businessBlockedRegions).toContain('US');
    expect(status.blockedRegions).not.toContain('US');
    expect(status.configured).toBe(false);
  });
});
