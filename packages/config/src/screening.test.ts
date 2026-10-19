import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SCREENING_ENFORCED_ENVS,
  SCREENING_FAIL_CLOSED_ENV,
  SHIPPED_BUSINESS_BLOCKS,
  UnscreenedJurisdictionError,
  activeScreeningList,
  assertScreeningConfigured,
  businessBlockFor,
  businessBlockedRegions,
  businessBlocksFrom,
  checkAccess,
  isRegionBlocked,
  screeningFailClosedFromEnv,
  screeningStatus,
  type JurisdictionEntry,
} from './jurisdiction.js';
import {
  OWNER_LIST_REQUIRED_ENVS,
  SCREENING_REFUSE_FIXTURE,
  SCREENING_REFUSE_UNCONFIGURED,
  SCREENING_REVIEWED_EMPTY,
  SHIPPED_SCREENING_REGIONS,
  ScreeningListError,
  ScreeningMoneyPostureError,
  UNSET_SCREENING_LIST,
  consultScreeningList,
  envScreeningList,
  evaluateScreeningMoneyPosture,
  ownerListSatisfiesBoot,
  ownerListSatisfiesMoneyPosture,
  parseScreeningList,
  screeningMoneyGrade,
} from './screening.js';

/**
 * THE GAP THIS CLOSES.
 *
 * The screening mechanism worked and screened nothing, and — this is the part
 * that mattered — nothing could tell. "We checked a sanctions list and you are
 * not on it" and "we have never had a sanctions list" produced the same
 * `allowed: true`, with the same code and the same reason string, at every call
 * site, in every test, and in every log line.
 *
 * These tests are about that indistinguishability. They are NOT about who
 * should be blocked. Every region code below is a placeholder chosen because it
 * cannot be mistaken for a real jurisdiction: AA, ZY and QQ are unassigned in
 * ISO-3166. Nothing in this repo names a real sanctioned country, because the
 * list is counsel's to write and an engineer's guess at it is a liability in
 * both directions.
 */

/** A stand-in for what counsel eventually supplies. Not a real list. */
const POPULATED = parseScreeningList('AA:placeholder programme,ZY', 'test-fixture-not-a-real-list');

/**
 * Unset `INTAFACED_SCREENING_FAIL_CLOSED` refuses. Tests that still need the
 * honesty path (allowed, list not configured, not screened-clean) pin explicit off.
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

describe('parsing the configured list', () => {
  it('treats absent, empty and whitespace-only as UNCONFIGURED, not as clear', () => {
    for (const raw of [undefined, '', '   ', ' , , ']) {
      const list = parseScreeningList(raw);
      expect(list.configured, JSON.stringify(raw)).toBe(false);
      expect(list.regions).toEqual([]);
    }
  });

  it('parses codes with and without reasons, and upper-cases them', () => {
    const list = parseScreeningList('aa:because,ZY');
    expect(list.configured).toBe(true);
    expect(list.regions.map((r) => r.region)).toEqual(['AA', 'ZY']);
    expect(list.regions[0]?.reason).toBe('because');
    // No reason supplied still produces one — a refusal with no explanation is
    // useless to the user and to the auditor.
    expect(list.regions[1]?.reason).toContain('ZY');
  });

  it('records provenance so a decision can say where the list came from', () => {
    expect(parseScreeningList('AA', 'counsel-memo-ref').source).toBe('counsel-memo-ref');
    expect(parseScreeningList('AA').source).toContain('INTAFACED_SANCTIONS_REGIONS');
  });

  /**
   * A dropped entry is a region we believe we are blocking and are not — the
   * original bug, reintroduced one typo at a time. It must be loud.
   */
  it('throws on a malformed entry rather than silently skipping it', () => {
    expect(() => parseScreeningList('AA,NOTACODE')).toThrow(ScreeningListError);
  });

  it('reports every problem at once, so a bad list is fixed in one pass', () => {
    try {
      parseScreeningList('TOOLONG,1,AA,AA');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScreeningListError);
      expect((e as ScreeningListError).issues).toHaveLength(3);
    }
  });

  it('rejects a duplicate region — one entry means one reason to maintain', () => {
    expect(() => parseScreeningList('AA:first,aa:second')).toThrow(ScreeningListError);
  });
});

describe('the state is observable — "screened and clear" vs "screened nothing"', () => {
  it('says NOT CONFIGURED rather than reporting a comfortable zero', () => {
    const status = screeningStatus(UNSET_SCREENING_LIST);
    expect(status.configured).toBe(false);
    expect(status.blockedRegions).toEqual([]);
    expect(status.summary).toContain('NOT CONFIGURED');
    // The summary must not be readable as a clean bill of health.
    expect(status.summary).toContain('nothing has been screened');
  });

  it('names the regions and the provenance once a list exists', () => {
    const status = screeningStatus(POPULATED);
    expect(status.configured).toBe(true);
    expect(status.blockedRegions).toEqual(['AA', 'ZY']);
    expect(status.summary).toContain('test-fixture-not-a-real-list');
    expect(status.summary).toContain('FIXTURE');
    expect(status.readsAsScreenedClean).toBe(false);
  });

  /**
   * The heart of it. Two ALLOWED decisions, same caller, same region, that used
   * to be byte-identical and are now distinguishable.
   */
  it('carries the difference on an ALLOWED decision, where it used to be invisible', () => {
    const query = { module: 'dex', plane: 'protocol', region: 'QQ', kycTier: 'none' } as const;

    const unscreened = checkAccess({ ...query, screening: UNSET_SCREENING_LIST });
    const screened = checkAccess({ ...query, screening: POPULATED });

    // Same outcome...
    expect(unscreened.allowed).toBe(true);
    expect(screened.allowed).toBe(true);
    expect(unscreened.code).toBe(screened.code);

    // ...different, and legible, provenance. This is what was impossible.
    expect(unscreened.screening.listConfigured).toBe(false);
    expect(unscreened.screening.blockedRegionCount).toBe(0);
    expect(screened.screening.listConfigured).toBe(true);
    expect(screened.screening.blockedRegionCount).toBe(2);
    expect(screened.screening.source).toBe('test-fixture-not-a-real-list');
    expect(unscreened.screening.readsAsScreenedClean).toBe(false);
    expect(screened.screening.readsAsScreenedClean).toBe(false);
    expect(screened.screening.moneyGrade).toBe('fixture');
  });

  it('carries provenance on denials too, including the plane-unsupported early return', () => {
    const d = checkAccess({ module: 'pay', plane: 'protocol', region: 'QQ', kycTier: 'full', screening: POPULATED });
    expect(d.code).toBe('denied.plane_unsupported');
    expect(d.screening.listConfigured).toBe(true);
  });
});

/**
 * D26-P1-O1 mechanism seal — request-time refuse when list unset.
 *
 * Boot guard already refuses prod start without a list. This is the twin at
 * checkAccess: an unset flag refuses, so hosted access cannot look
 * screened-clean with no counsel content. Explicit off keeps honesty-only.
 * No real sanctions codes — AA/QQ placeholders only.
 */
describe('screening fail-closed — refuse when list unset (D26-P1-O1)', () => {
  const original = process.env[SCREENING_FAIL_CLOSED_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[SCREENING_FAIL_CLOSED_ENV];
    else process.env[SCREENING_FAIL_CLOSED_ENV] = original;
  });

  it('refuses hosted access when INTAFACED_SCREENING_FAIL_CLOSED is unset', () => {
    delete process.env[SCREENING_FAIL_CLOSED_ENV];
    expect(screeningFailClosedFromEnv({})).toBe(true);
    const d = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'QQ',
      kycTier: 'none',
      screening: UNSET_SCREENING_LIST,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('denied.screening_unconfigured');
    expect(d.screening.listConfigured).toBe(false);
    expect(d.screening.readsAsScreenedClean).toBe(false);
  });

  it('isolates the protocol startup custody probe while real requests retain default screening refusal', () => {
    delete process.env[SCREENING_FAIL_CLOSED_ENV];
    const startup = checkAccess({
      module: 'protocol',
      plane: 'protocol',
      region: 'XX',
      kycTier: 'none',
      regionFailClosed: false,
      screeningFailClosed: false,
      screening: UNSET_SCREENING_LIST,
    });
    expect(startup.code).toBe('allowed.permissionless');
    expect(startup.regionResolved).toBe(false);
    expect(startup.screening.declaration).toBe('unset');
    expect(startup.screening.listConfigured).toBe(false);
    expect(startup.screening.readsAsScreenedClean).toBe(false);
    const request = checkAccess({
      module: 'protocol',
      plane: 'protocol',
      region: 'XX',
      kycTier: 'none',
      screening: UNSET_SCREENING_LIST,
    });
    expect(request.allowed).toBe(false);
    expect(request.code).toBe('denied.screening_unconfigured');
    expect(request.regionResolved).toBe(false);
    expect(request.screening).toEqual(startup.screening);
  });

  it('explicit off keeps honesty-only allow with listConfigured false', () => {
    process.env[SCREENING_FAIL_CLOSED_ENV] = 'off';
    const d = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'QQ',
      kycTier: 'none',
      screening: UNSET_SCREENING_LIST,
    });
    expect(d.allowed).toBe(true);
    expect(d.screening.listConfigured).toBe(false);
    expect(d.screening.declaration).toBe('unset');
    expect(d.screening.readsAsScreenedClean).toBe(false);
  });

  it.each(['', '   ', 'tru', 'disabled', '2'])('refuses blank or malformed flag %j through checkAccess', (flag) => {
    process.env[SCREENING_FAIL_CLOSED_ENV] = flag;
    const d = checkAccess({
      module: 'bank',
      plane: 'fiat',
      region: ' GB ',
      kycTier: 'full',
      screening: UNSET_SCREENING_LIST,
    });
    expect(d.code).toBe('denied.screening_unconfigured');
    expect(d.regionResolved).toBe(true);
    expect(d.screening.readsAsScreenedClean).toBe(false);
  });

  it.each(['0', ' FALSE ', 'No', ' off '])('keeps explicit off %j honest through checkAccess', (flag) => {
    process.env[SCREENING_FAIL_CLOSED_ENV] = flag;
    const d = checkAccess({
      module: 'bank',
      plane: 'fiat',
      region: ' GB ',
      kycTier: 'full',
      screening: UNSET_SCREENING_LIST,
    });
    expect(d.allowed).toBe(true);
    expect(d.screening.listConfigured).toBe(false);
    expect(d.screening.readsAsScreenedClean).toBe(false);
  });

  it('refuses unset when screeningFailClosed is armed on the query', () => {
    const d = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'QQ',
      kycTier: 'none',
      screening: UNSET_SCREENING_LIST,
      screeningFailClosed: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('denied.screening_unconfigured');
    expect(d.screening.listConfigured).toBe(false);
    expect(d.reason).toContain(SCREENING_FAIL_CLOSED_ENV);
    expect(d.reason).toMatch(/must not invent list content/i);
  });

  it('reads INTAFACED_SCREENING_FAIL_CLOSED from the environment', () => {
    expect(screeningFailClosedFromEnv({})).toBe(true);
    expect(screeningFailClosedFromEnv({ [SCREENING_FAIL_CLOSED_ENV]: '1' })).toBe(true);
    expect(screeningFailClosedFromEnv({ [SCREENING_FAIL_CLOSED_ENV]: 'true' })).toBe(true);
    expect(screeningFailClosedFromEnv({ [SCREENING_FAIL_CLOSED_ENV]: 'yes' })).toBe(true);
    expect(screeningFailClosedFromEnv({ [SCREENING_FAIL_CLOSED_ENV]: 'on' })).toBe(true);
    expect(screeningFailClosedFromEnv({ APP_ENV: 'test', [SCREENING_FAIL_CLOSED_ENV]: 'no' })).toBe(false);
    expect(screeningFailClosedFromEnv({ APP_ENV: 'test', [SCREENING_FAIL_CLOSED_ENV]: '0' })).toBe(false);
    expect(screeningFailClosedFromEnv({ APP_ENV: 'test', [SCREENING_FAIL_CLOSED_ENV]: 'false' })).toBe(false);

    process.env[SCREENING_FAIL_CLOSED_ENV] = 'yes';
    const d = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'QQ',
      kycTier: 'none',
      screening: UNSET_SCREENING_LIST,
    });
    expect(d.code).toBe('denied.screening_unconfigured');
  });

  it('does not refuse counsel-grade reviewed-empty or listed', () => {
    const reviewed = parseScreeningList(SCREENING_REVIEWED_EMPTY, 'counsel-memo-ref');
    const cleared = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'QQ',
      kycTier: 'none',
      screening: reviewed,
      screeningFailClosed: true,
    });
    expect(cleared.allowed).toBe(true);
    expect(cleared.screening.declaration).toBe('reviewed-empty');
    expect(cleared.screening.readsAsScreenedClean).toBe(true);

    const counselListed = parseScreeningList('AA:programme-ref', 'counsel-memo-ref');
    const listed = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'QQ',
      kycTier: 'none',
      screening: counselListed,
      screeningFailClosed: true,
    });
    expect(listed.allowed).toBe(true);
    expect(listed.screening.listConfigured).toBe(true);
    expect(listed.screening.readsAsScreenedClean).toBe(true);
  });

  it('refuses a placeholder/test list in a money posture — not screened clean', () => {
    const d = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'QQ',
      kycTier: 'none',
      screening: POPULATED,
      screeningFailClosed: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe(SCREENING_REFUSE_FIXTURE);
    expect(d.screening.readsAsScreenedClean).toBe(false);
    expect(d.screening.moneyGrade).toBe('fixture');
  });

  it('query flag wins over a false env', () => {
    process.env[SCREENING_FAIL_CLOSED_ENV] = '0';
    const d = checkAccess({
      module: 'trade',
      plane: 'fiat',
      region: 'QQ',
      kycTier: 'full',
      screening: UNSET_SCREENING_LIST,
      screeningFailClosed: true,
    });
    expect(d.code).toBe('denied.screening_unconfigured');
  });
});

describe('a populated list actually screens', () => {
  it('refuses a listed region on the PROTOCOL plane, KYC gate or not', () => {
    const d = checkAccess({ module: 'dex', plane: 'protocol', region: 'AA', kycTier: 'none', screening: POPULATED });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('denied.region_blocked');
    expect(d.reason).toBe('placeholder programme');
  });

  it('refuses a listed region on the CUSTODIAL plane even at the top tier', () => {
    const d = checkAccess({ module: 'trade', plane: 'fiat', region: 'AA', kycTier: 'institutional', screening: POPULATED });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('denied.region_blocked');
  });

  it('refuses regardless of the case the region arrives in', () => {
    const d = checkAccess({ module: 'dex', plane: 'protocol', region: 'zy', kycTier: 'none', screening: POPULATED });
    expect(d.code).toBe('denied.region_blocked');
  });

  it('allows a region that is NOT on the list', () => {
    const d = checkAccess({ module: 'dex', plane: 'protocol', region: 'QQ', kycTier: 'none', screening: POPULATED });
    expect(d.allowed).toBe(true);
  });

  it('leaves the rest of the matrix alone — an unlisted region keeps its tier gate', () => {
    const d = checkAccess({ module: 'bank', plane: 'fiat', region: 'DE', kycTier: 'basic', screening: POPULATED });
    expect(d.code).toBe('denied.kyc_required');
  });

  it('isRegionBlocked answers from the configured list, not only the matrix', () => {
    expect(isRegionBlocked('AA', POPULATED)).toBe(true);
    expect(isRegionBlocked('QQ', POPULATED)).toBe(false);
    expect(isRegionBlocked('AA', UNSET_SCREENING_LIST)).toBe(false);
  });
});

/**
 * §22 + §24 Lane A together. Screening runs BEFORE the permissionless
 * short-circuit; the KYC gate runs after it and is skipped. Losing that
 * ordering turns "zero-KYC but still sanctions screened" from a property into a
 * slogan, so it gets tests in both directions.
 */
describe('ordering: sanctions screening survives the permissionless short-circuit, KYC does not', () => {
  it('still resolves a non-listed region to allowed.permissionless AFTER screening', () => {
    const d = checkAccess({ module: 'dex', plane: 'protocol', region: 'QQ', kycTier: 'none', screening: POPULATED });
    expect(d.code).toBe('allowed.permissionless');
    // And it says a list was consulted on the way there.
    expect(d.screening.listConfigured).toBe(true);
  });

  it('never returns allowed.permissionless for a listed region, at any tier', () => {
    for (const kycTier of ['none', 'basic', 'full', 'institutional'] as const) {
      const d = checkAccess({ module: 'dex', plane: 'protocol', region: 'AA', kycTier, screening: POPULATED });
      expect(d.code, kycTier).toBe('denied.region_blocked');
    }
  });

  it('the protocol module itself keeps its §22 guarantee for a non-listed region', () => {
    const d = checkAccess({ module: 'protocol', plane: 'protocol', region: 'XX', kycTier: 'none', screening: POPULATED });
    expect(d.code).toBe('allowed.permissionless');
  });
});

describe('boot guard — production-like postures refuse to start unscreened', () => {
  it.each(SCREENING_ENFORCED_ENVS)('throws for APP_ENV=%s with no list', (appEnv) => {
    expect(() => assertScreeningConfigured({ APP_ENV: appEnv })).toThrow(UnscreenedJurisdictionError);
  });

  it('names the env and the refuse code rather than just failing', () => {
    try {
      assertScreeningConfigured({ APP_ENV: 'prod' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnscreenedJurisdictionError);
      const error = e as UnscreenedJurisdictionError;
      expect(error.code).toBe(SCREENING_REFUSE_UNCONFIGURED);
      expect(error.message).toContain('APP_ENV=prod');
      expect(error.message).toContain(SCREENING_REFUSE_UNCONFIGURED);
      expect(error.message).toContain('INTAFACED_SANCTIONS_REGIONS');
      expect(error.message).toContain('COMPLIANCE DECISION');
    }
  });

  it.each(SCREENING_ENFORCED_ENVS)('empty and whitespace refuse by name for APP_ENV=%s', (appEnv) => {
    for (const raw of [undefined, '', '   ', ' , , ']) {
      try {
        assertScreeningConfigured({ APP_ENV: appEnv, INTAFACED_SANCTIONS_REGIONS: raw });
        expect.unreachable(`should have thrown for ${JSON.stringify(raw)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(UnscreenedJurisdictionError);
        const error = e as UnscreenedJurisdictionError;
        expect(error.code).toBe(SCREENING_REFUSE_UNCONFIGURED);
        expect(error.message).toContain(`APP_ENV=${appEnv}`);
        expect(error.message).toContain(SCREENING_REFUSE_UNCONFIGURED);
      }
    }
  });

  it('refuses a placeholder list in prod/staging — fixture is not counsel', () => {
    for (const appEnv of SCREENING_ENFORCED_ENVS) {
      try {
        assertScreeningConfigured({ APP_ENV: appEnv, INTAFACED_SANCTIONS_REGIONS: 'AA:placeholder' });
        expect.unreachable(`fixture must not boot ${appEnv}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ScreeningMoneyPostureError);
        const error = e as ScreeningMoneyPostureError;
        expect(error.code).toBe(SCREENING_REFUSE_FIXTURE);
        expect(error.message).toContain(`APP_ENV=${appEnv}`);
        expect(error.message).toMatch(/must not invent country codes/i);
      }
    }
  });

  it('boots in prod once a counsel-grade list is supplied', () => {
    const status = assertScreeningConfigured({
      APP_ENV: 'prod',
      INTAFACED_SANCTIONS_REGIONS: 'AA:programme-ref',
      INTAFACED_SANCTIONS_LIST_SOURCE: 'counsel-memo-ref',
    });
    expect(status.configured).toBe(true);
    expect(status.blockedRegions).toEqual(['AA']);
    expect(status.readsAsScreenedClean).toBe(true);
    expect(status.moneyGrade).toBe('counsel');
  });

  it('keeps development frictionless — dev and test boot empty and report the gap', () => {
    for (const appEnv of ['dev', 'test']) {
      const status = assertScreeningConfigured({ APP_ENV: appEnv });
      expect(status.configured, appEnv).toBe(false);
      expect(status.summary, appEnv).toContain('NOT CONFIGURED');
    }
  });

  it('refuses an unconfigured list when APP_ENV is unset', () => {
    expect(() => assertScreeningConfigured({})).toThrow(UnscreenedJurisdictionError);
  });

  it('a whitespace-only variable does not satisfy the guard', () => {
    expect(() => assertScreeningConfigured({ APP_ENV: 'prod', INTAFACED_SANCTIONS_REGIONS: '  ,  ' })).toThrow(UnscreenedJurisdictionError);
  });
});

describe('the process-wide list is read from the environment', () => {
  const original = process.env.INTAFACED_SANCTIONS_REGIONS;
  afterEach(() => {
    if (original === undefined) delete process.env.INTAFACED_SANCTIONS_REGIONS;
    else process.env.INTAFACED_SANCTIONS_REGIONS = original;
  });

  it('picks up a change with no reset hook for anyone to forget', () => {
    expect(activeScreeningList().configured).toBe(false);

    process.env.INTAFACED_SANCTIONS_REGIONS = 'AA:placeholder';
    expect(activeScreeningList().configured).toBe(true);

    // And `checkAccess` with no explicit list honours it — this is the path
    // every production call site takes.
    expect(checkAccess({ module: 'dex', plane: 'protocol', region: 'AA', kycTier: 'none' }).code).toBe('denied.region_blocked');

    delete process.env.INTAFACED_SANCTIONS_REGIONS;
    expect(activeScreeningList().configured).toBe(false);
  });
});

/**
 * TWO AUTHORITIES, AND NEITHER MAY VOUCH FOR THE OTHER.
 *
 * THE BUG. `MATRIX_SCREENING` turned every `blocked: true` entry in
 * `JURISDICTION_MATRIX` into a `ScreeningList` and `activeScreeningList` merged
 * it with the counsel-supplied one. `mergeScreeningLists` set `configured: true`
 * if EITHER side had anything, and `assertScreeningConfigured` gated on exactly
 * that flag.
 *
 * So one region blocked for a commercial reason — a licence we lack, a market we
 * have not opened, a placeholder somebody left — flipped the production boot
 * guard from "refuse to start" to "satisfied", with the sanctions list still
 * empty and nobody in counsel having supplied a thing. Business configuration,
 * edited in ordinary PRs by ordinary contributors, silently arming a legal
 * control. Latent only because the shipped matrix happens to contain no
 * `blocked: true` entry; live the first time anybody adds one.
 *
 * These tests use a SYNTHETIC matrix, because the shipped one has no blocked
 * entry and a rule about the blocked case that can only be exercised once
 * somebody adds one is a rule with no test.
 *
 * ── AND THAT IS NOT A STYLE POINT ────────────────────────────────────────────
 *
 * `SHIPPED_BUSINESS_BLOCKS` is EMPTY — asserted below, and asserted again under
 * "what ships". So any test in this file that exercises the business authority
 * WITHOUT passing a staged set is not testing the business authority. It is
 * asserting that nothing fails to satisfy a guard, which was true of the
 * merged-authority code this change replaced: it would have passed identically
 * before the fix.
 *
 * That is exactly what the previous version of `leaves the prod boot guard
 * refusing` did. It called `assertScreeningConfigured({ APP_ENV: 'prod' })` with
 * no business blocks anywhere near it, under a name that claims a business block
 * was present and was refused. A compliance test that cannot fail is worse than
 * no test, because the name is read as evidence.
 *
 * So every test below passes `COMMERCIAL_BLOCKS` explicitly, and the ones about
 * the guard additionally assert that the guard SAW the staged block — by
 * checking that the refusal names it. Losing the argument then turns the test
 * red instead of turning it vacuous.
 */
describe('a business block cannot satisfy the screening guard', () => {
  /** A commercially-blocked region. QQ is unassigned in ISO-3166. */
  const COMMERCIAL: readonly JurisdictionEntry[] = [
    { region: '*' },
    { region: 'QQ', blocked: true, reason: 'No licence in this market yet — commercial, not sanctions' },
  ];

  /** The staged set, passed to every seam below. Never the shipped one. */
  const COMMERCIAL_BLOCKS = businessBlocksFrom(COMMERCIAL);

  /**
   * The precondition the rest of this block depends on. If the shipped matrix
   * ever gains a `blocked: true` entry this fails FIRST, and the reader learns
   * that the "no business block staged" baseline used below is no longer a
   * baseline — rather than the tests below quietly starting to pass for the
   * wrong reason.
   */
  it('the shipped matrix stages nothing, so an unstaged test would prove nothing', () => {
    expect(SHIPPED_BUSINESS_BLOCKS).toEqual([]);
    expect(COMMERCIAL_BLOCKS).toHaveLength(1);
  });

  it('still blocks the region — nothing about the existing refusal is weakened', () => {
    expect(COMMERCIAL_BLOCKS.map((b) => b.region)).toEqual(['QQ']);
    expect(COMMERCIAL_BLOCKS[0]?.authority).toBe('business');
  });

  it('is NOT counted as screening coverage, however many there are', () => {
    const status = screeningStatus(UNSET_SCREENING_LIST, COMMERCIAL_BLOCKS);

    // The whole finding, as an assertion.
    expect(status.configured).toBe(false);
    expect(status.declaration).toBe('unset');

    // Reported, and reported as a different number under a different name.
    expect(status.blockedRegions).toEqual([]);
    expect(status.businessBlockedRegions).toEqual(['QQ']);
  });

  it('says out loud that the business blocks are not screening', () => {
    const status = screeningStatus(UNSET_SCREENING_LIST, COMMERCIAL_BLOCKS);
    expect(status.summary).toContain('NOT CONFIGURED');
    expect(status.summary).toContain('not screening');
  });

  /**
   * THE GUARD ITSELF, WITH A COMMERCIAL BLOCK ACTUALLY IN FRONT OF IT.
   *
   * The claim under test — "a commercial block cannot satisfy a sanctions
   * guard" — is a claim about what happens WHEN ONE EXISTS. Calling the guard
   * with none tests nothing; the merged-authority code refused that input too.
   *
   * So: stage one, call the guard, and then prove the guard SAW it, by reading
   * the staged region back off the refusal. A future edit that drops the second
   * argument makes `businessBlockedRegions` come back empty and this goes red.
   */
  it('leaves the prod boot guard refusing, with a commercial block staged and seen', () => {
    let thrown: unknown;
    try {
      assertScreeningConfigured({ APP_ENV: 'prod' }, COMMERCIAL_BLOCKS);
      expect.unreachable('a commercial block must not satisfy the sanctions guard');
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(UnscreenedJurisdictionError);
    const error = thrown as UnscreenedJurisdictionError;

    // The guard saw the block — this is the assertion that keeps the test from
    // going vacuous again.
    expect(error.businessBlockedRegions).toEqual(['QQ']);
    expect(error.message).toContain('QQ');
    // ...and said, in the refusal itself, why seeing it changed nothing.
    expect(error.message).toContain('do NOT satisfy this');
  });

  it.each(SCREENING_ENFORCED_ENVS)('and refuses the same way for APP_ENV=%s', (appEnv) => {
    expect(() => assertScreeningConfigured({ APP_ENV: appEnv }, COMMERCIAL_BLOCKS)).toThrow(UnscreenedJurisdictionError);
  });

  /** Not a threshold that a busy enough matrix eventually clears. */
  it('is not satisfied by many commercial blocks either', () => {
    const many = businessBlocksFrom([
      { region: '*' },
      { region: 'QQ', blocked: true, reason: 'no licence' },
      { region: 'XA', blocked: true, reason: 'market not opened' },
      { region: 'XB', blocked: true, reason: 'placeholder' },
    ]);
    expect(many).toHaveLength(3);
    expect(() => assertScreeningConfigured({ APP_ENV: 'prod' }, many)).toThrow(UnscreenedJurisdictionError);
  });

  /**
   * THE OTHER HALF, AND THE ONE THAT PROVES THE TWO ARE SEPARATED RATHER THAN
   * BOTH REFUSED. The same staged commercial block, plus counsel's list: the
   * guard is satisfied — by the screening authority, alone — and the two
   * region sets stay under two names and are never summed.
   */
  it('and the guard IS satisfied by the screening authority with the same block still staged', () => {
    const status = assertScreeningConfigured(
      { APP_ENV: 'prod', INTAFACED_SANCTIONS_REGIONS: 'AA:programme-ref', INTAFACED_SANCTIONS_LIST_SOURCE: 'counsel-memo-ref' },
      COMMERCIAL_BLOCKS,
    );
    expect(status.configured).toBe(true);
    expect(status.declaration).toBe('listed');
    expect(status.blockedRegions).toEqual(['AA']); // counsel's
    expect(status.businessBlockedRegions).toEqual(['QQ']); // the business's, still separate
  });

  it('a business block does not become a ScreenedRegion, so it cannot be merged back in by accident', () => {
    // Types keep them apart; this asserts the runtime tag agrees, which is what
    // a log or an audit row actually reads.
    for (const b of COMMERCIAL_BLOCKS) expect(b.authority).not.toBe('screening');
  });

  /**
   * Ambiguity fails closed. A `blocked: true` entry with no reason at all —
   * nobody can tell whether it was commercial or legal — refuses in BOTH
   * directions: the region stays blocked, and the guard stays unsatisfied.
   */
  it('an unexplained block refuses in both directions rather than being read as either', () => {
    const unexplained: readonly JurisdictionEntry[] = [{ region: '*' }, { region: 'QQ', blocked: true }];
    const blocks = businessBlocksFrom(unexplained);

    expect(blocks).toHaveLength(1); // still refuses the region
    const status = screeningStatus(UNSET_SCREENING_LIST, blocks);
    expect(status.configured).toBe(false); // and still does not satisfy screening
    // And the region is genuinely refused, not merely counted — the "both
    // directions" in the name is two assertions, not one.
    expect(isRegionBlocked('QQ', UNSET_SCREENING_LIST, blocks)).toBe(true);
  });

  /**
   * The seam changes no default. Production call sites pass one argument and
   * get the shipped matrix, exactly as before it existed.
   */
  it('production callers pass nothing and get the shipped matrix', () => {
    expect(businessBlockedRegions()).toEqual([]);
    expect(businessBlockFor('QQ')).toBeUndefined();
    expect(screeningStatus(UNSET_SCREENING_LIST).businessBlockedRegions).toEqual([]);
    expect(() => assertScreeningConfigured({ APP_ENV: 'prod' })).toThrow(UnscreenedJurisdictionError);
  });
});

/**
 * THE BUSINESS AUTHORITY'S REFUSAL, EXERCISED FOR THE FIRST TIME.
 *
 * Everything here was unreachable until the `business` seam existed. The
 * shipped matrix declares no `blocked: true` entry, so `businessBlockFor`
 * returned `undefined` in every test that had ever run against this file: the
 * business half of `isRegionBlocked`, `blockedBy: 'business'`, and the §24
 * Lane A ordering FOR A COMMERCIALLY-BLOCKED REGION were all code that no
 * assertion had ever entered. Tests over them would have passed against an
 * implementation that did not have them.
 *
 * Each test below is paired with the same query and no staged block, so the
 * refusal is attributable to the block rather than to the query.
 */
describe('a commercial block refuses the region, and says the business refused it', () => {
  const COMMERCIAL_BLOCKS = businessBlocksFrom([
    { region: '*' },
    { region: 'QQ', blocked: true, reason: 'No licence in this market yet — commercial, not sanctions' },
  ]);

  it('refuses on the custodial plane and attributes it to the business', () => {
    const query = { module: 'trade', plane: 'fiat', region: 'QQ', kycTier: 'institutional', screening: UNSET_SCREENING_LIST } as const;

    const blocked = checkAccess({ ...query, business: COMMERCIAL_BLOCKS });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('denied.region_blocked');
    expect(blocked.blockedBy).toBe('business');
    expect(blocked.reason).toBe('No licence in this market yet — commercial, not sanctions');

    // The control: same caller, same region, nothing staged. Allowed. So the
    // refusal above came from the block and not from the query.
    expect(checkAccess(query).allowed).toBe(true);
  });

  it('refuses regardless of the case the region arrives in', () => {
    const d = checkAccess({
      module: 'trade',
      plane: 'fiat',
      region: 'qq',
      kycTier: 'institutional',
      screening: UNSET_SCREENING_LIST,
      business: COMMERCIAL_BLOCKS,
    });
    expect(d.code).toBe('denied.region_blocked');
  });

  /**
   * §24 LANE A, FOR THE BUSINESS AUTHORITY.
   *
   * `dex` on the `protocol` plane is the exact shape that short-circuits to
   * `allowed.permissionless` before any tier is read. The region check runs
   * BEFORE that return — sovereign does not mean unserved-region-served — and
   * that ordering has to hold for both authorities, not only the one that
   * happened to be testable. Lifting the permissionless return above the region
   * check turns this red.
   */
  it('§24 Lane A: the region check runs BEFORE the permissionless short-circuit', () => {
    const query = { module: 'dex', plane: 'protocol', region: 'QQ', kycTier: 'none', screening: UNSET_SCREENING_LIST } as const;

    const blocked = checkAccess({ ...query, business: COMMERCIAL_BLOCKS });
    expect(blocked.code).toBe('denied.region_blocked');
    expect(blocked.blockedBy).toBe('business');

    // Unstaged, the very same query short-circuits — which is what makes the
    // line above an ordering assertion rather than a KYC one.
    expect(checkAccess(query).code).toBe('allowed.permissionless');
  });

  it('and a permissionless caller in a region nobody blocks is still allowed', () => {
    const d = checkAccess({
      module: 'dex',
      plane: 'protocol',
      region: 'ZY',
      kycTier: 'none',
      screening: UNSET_SCREENING_LIST,
      business: COMMERCIAL_BLOCKS,
    });
    expect(d.code).toBe('allowed.permissionless');
    expect(d.blockedBy).toBeUndefined();
  });

  /**
   * When both authorities name the region, SCREENING takes the attribution and
   * the screening reason is the one the user is given. The legal control is the
   * more consequential fact and it is the one that must not look removable by
   * editing the matrix.
   */
  it('screening wins the attribution when both authorities name the same region', () => {
    const both = businessBlocksFrom([{ region: '*' }, { region: 'AA', blocked: true, reason: 'commercial reason' }]);
    const d = checkAccess({ module: 'dex', plane: 'protocol', region: 'AA', kycTier: 'none', screening: POPULATED, business: both });

    expect(d.code).toBe('denied.region_blocked');
    expect(d.blockedBy).toBe('screening');
    expect(d.reason).toBe('placeholder programme');
    expect(d.reason).not.toContain('commercial');
  });

  it('isRegionBlocked answers true from the business half of the OR', () => {
    expect(isRegionBlocked('QQ', UNSET_SCREENING_LIST, COMMERCIAL_BLOCKS)).toBe(true);
    expect(isRegionBlocked('qq', UNSET_SCREENING_LIST, COMMERCIAL_BLOCKS)).toBe(true);
    // Same region, shipped matrix: the seam is what made the line above reachable.
    expect(isRegionBlocked('QQ', UNSET_SCREENING_LIST, SHIPPED_BUSINESS_BLOCKS)).toBe(false);
  });

  it('businessBlockFor and businessBlockedRegions read the staged set', () => {
    expect(businessBlockedRegions(COMMERCIAL_BLOCKS)).toEqual(['QQ']);
    expect(businessBlockFor('qq', COMMERCIAL_BLOCKS)?.authority).toBe('business');
    expect(businessBlockFor('qq', COMMERCIAL_BLOCKS)?.source).toBe('JURISDICTION_MATRIX');
    expect(businessBlockFor('QQ', SHIPPED_BUSINESS_BLOCKS)).toBeUndefined();
  });
});

/**
 * WHICH AUTHORITY REFUSED, on the decision itself.
 *
 * A legal control and a commercial choice produce the same `denied.region_blocked`,
 * and they are not the same fact. An auditor who cannot tell them apart cannot
 * tell whether a refusal that disappeared was a market opening or a sanctions
 * control being tuned away while somebody adjusted something else.
 */
describe('every refusal records which authority made it', () => {
  it('attributes a screening-list refusal to the screening authority', () => {
    const d = checkAccess({ module: 'dex', plane: 'protocol', region: 'AA', kycTier: 'none', screening: POPULATED });
    expect(d.code).toBe('denied.region_blocked');
    expect(d.blockedBy).toBe('screening');
  });

  it('leaves it absent when nothing refused', () => {
    const d = checkAccess({ module: 'dex', plane: 'protocol', region: 'QQ', kycTier: 'none', screening: POPULATED });
    expect(d.allowed).toBe(true);
    expect(d.blockedBy).toBeUndefined();
  });
});

/**
 * "REVIEWED, AND DELIBERATELY EMPTY" IS NOT "NOBODY HAS DONE THIS YET".
 *
 * Both screen zero regions. One is a conclusion somebody reached and signed;
 * the other is a gap. A platform that cannot record the first has only two
 * options once counsel answers "no regions" — lie by inventing an entry, or run
 * forever with a boot guard it cannot satisfy — and both are worse than a state.
 */
describe('the deliberately-empty list is a distinct, attributable state', () => {
  const ATTESTED = {
    APP_ENV: 'prod',
    INTAFACED_SANCTIONS_REGIONS: SCREENING_REVIEWED_EMPTY,
    INTAFACED_SANCTIONS_LIST_SOURCE: 'counsel-memo-ref',
  };

  it('satisfies the boot guard when it is attributed', () => {
    const status = assertScreeningConfigured(ATTESTED);
    expect(status.declaration).toBe('reviewed-empty');
    expect(status.configured).toBe(true);
    expect(status.blockedRegions).toEqual([]);
  });

  it('REFUSES without attribution — an unsigned "none" is indistinguishable from silencing the guard', () => {
    expect(() => assertScreeningConfigured({ APP_ENV: 'prod', INTAFACED_SANCTIONS_REGIONS: SCREENING_REVIEWED_EMPTY })).toThrow(
      ScreeningListError,
    );
  });

  it('the refusal tells the reader that leaving it unset is the honest alternative', () => {
    try {
      parseScreeningList(SCREENING_REVIEWED_EMPTY);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScreeningListError);
      expect((e as Error).message).toContain('leave INTAFACED_SANCTIONS_REGIONS unset');
    }
  });

  it('is a DIFFERENT state from unset, not merely a different summary', () => {
    const reviewed = parseScreeningList(SCREENING_REVIEWED_EMPTY, 'counsel-memo-ref');
    expect(reviewed.declaration).toBe('reviewed-empty');
    expect(UNSET_SCREENING_LIST.declaration).toBe('unset');

    // Same zero regions. Different states. That is the entire point.
    expect(reviewed.regions).toEqual(UNSET_SCREENING_LIST.regions);
    expect(reviewed.declaration).not.toBe(UNSET_SCREENING_LIST.declaration);
  });

  it('names the authority in the summary rather than reading as a clean tick', () => {
    const status = screeningStatus(parseScreeningList(SCREENING_REVIEWED_EMPTY, 'counsel-memo-ref'), []);
    expect(status.summary).toContain('DELIBERATELY EMPTY');
    expect(status.summary).toContain('counsel-memo-ref');
    // It must not read as "we screened everyone and everyone is fine".
    expect(status.summary).toContain('recorded decision');
  });

  /**
   * The state reaches the decision, not just the dashboard. `listConfigured:
   * true` with a count of zero used to be unreachable; now it means something
   * specific, and a reader with only the boolean and the count cannot tell it
   * from a short list.
   */
  it('rides on every decision, so a zero count is legible', () => {
    const reviewed = parseScreeningList(SCREENING_REVIEWED_EMPTY, 'counsel-memo-ref');
    const d = checkAccess({ module: 'dex', plane: 'protocol', region: 'QQ', kycTier: 'none', screening: reviewed });

    expect(d.allowed).toBe(true);
    expect(d.screening.listConfigured).toBe(true);
    expect(d.screening.blockedRegionCount).toBe(0);
    expect(d.screening.declaration).toBe('reviewed-empty');
    expect(d.screening.readsAsScreenedClean).toBe(true);
  });

  it('an unset list still says unset on the decision', () => {
    const d = checkAccess({ module: 'dex', plane: 'protocol', region: 'QQ', kycTier: 'none', screening: UNSET_SCREENING_LIST });
    expect(d.screening.declaration).toBe('unset');
  });

  it('is case-insensitive, because config files are typed by people', () => {
    expect(parseScreeningList('NONE', 'ref').declaration).toBe('reviewed-empty');
    expect(parseScreeningList(' None ', 'ref').declaration).toBe('reviewed-empty');
  });

  /** It must be the WHOLE value — never a member of a list. */
  it('is not a list entry — "none,AA" is a malformed list, not an attestation', () => {
    expect(() => parseScreeningList('none,AA', 'ref')).toThrow(ScreeningListError);
  });
});

describe('money posture — empty and fixtures never read as screened clean (D26-P1-O1)', () => {
  const COUNSEL = parseScreeningList('AA:programme-ref', 'counsel-memo-ref');

  it.each(OWNER_LIST_REQUIRED_ENVS)('evaluateScreeningMoneyPosture refuses unset by name in %s', (appEnv) => {
    const posture = evaluateScreeningMoneyPosture(UNSET_SCREENING_LIST, appEnv);
    expect(posture.allowed).toBe(false);
    expect(posture.code).toBe(SCREENING_REFUSE_UNCONFIGURED);
    expect(posture.readsAsScreenedClean).toBe(false);
    expect(posture.grade).toBe('unconfigured');
  });

  it.each(OWNER_LIST_REQUIRED_ENVS)('evaluateScreeningMoneyPosture refuses fixture by name in %s', (appEnv) => {
    const posture = evaluateScreeningMoneyPosture(POPULATED, appEnv);
    expect(posture.allowed).toBe(false);
    expect(posture.code).toBe(SCREENING_REFUSE_FIXTURE);
    expect(posture.readsAsScreenedClean).toBe(false);
    expect(ownerListSatisfiesMoneyPosture(POPULATED)).toBe(false);
  });

  it('dev may boot on a fixture gap but still does not read as clean', () => {
    const posture = evaluateScreeningMoneyPosture(POPULATED, 'dev');
    expect(posture.allowed).toBe(true);
    expect(posture.code).toBe('allowed.screening_dev_gap');
    expect(posture.readsAsScreenedClean).toBe(false);
  });

  it('counsel-grade listed is the only clean money posture', () => {
    expect(screeningMoneyGrade(COUNSEL)).toBe('counsel');
    expect(ownerListSatisfiesMoneyPosture(COUNSEL)).toBe(true);
    const posture = evaluateScreeningMoneyPosture(COUNSEL, 'prod');
    expect(posture.allowed).toBe(true);
    expect(posture.code).toBe('allowed.screening_counsel');
    expect(posture.readsAsScreenedClean).toBe(true);
    expect(consultScreeningList(COUNSEL, 'QQ').outcome).toBe('clear');
  });
});

/**
 * The list SHIPS EMPTY, deliberately. Asserted so that nobody can merge a
 * guessed sanctions list into the repo without this failing and a human having
 * to say who signed it off.
 */
describe('what ships', () => {
  it('ships no blocklist — the mechanism is armed, the contents are counsel’s', () => {
    const shipped = activeScreeningList({});
    expect(shipped.configured).toBe(false);
    expect(shipped.declaration).toBe('unset');
    expect(shipped.regions).toEqual([]);
    expect(SHIPPED_SCREENING_REGIONS).toEqual([]);
    expect(envScreeningList({})).toBe(UNSET_SCREENING_LIST);
    expect(ownerListSatisfiesBoot(UNSET_SCREENING_LIST)).toBe(false);
    expect(ownerListSatisfiesMoneyPosture(UNSET_SCREENING_LIST)).toBe(false);
  });

  /**
   * Empty/unset cannot silently pass a hit. Consulting QQ (unassigned ISO-3166)
   * against the shipped list is `unconsulted`, never `clear`.
   */
  it('an empty list cannot silently pass a hit — consult is unconsulted, not clear', () => {
    const consult = consultScreeningList(UNSET_SCREENING_LIST, 'QQ');
    expect(consult.outcome).toBe('unconsulted');
    expect(consult.outcome).not.toBe('clear');
    expect(consult.declaration).toBe('unset');

    const listed = parseScreeningList('AA:placeholder programme', 'test-fixture-not-a-real-list');
    expect(consultScreeningList(listed, 'AA').outcome).toBe('hit');
    expect(consultScreeningList(listed, 'QQ').outcome).toBe('fixture');
    expect(consultScreeningList(listed, 'QQ').outcome).not.toBe('clear');
  });

  it('prod and staging still refuse to boot without an owner list', () => {
    expect([...SCREENING_ENFORCED_ENVS]).toEqual([...OWNER_LIST_REQUIRED_ENVS]);
    for (const appEnv of OWNER_LIST_REQUIRED_ENVS) {
      expect(ownerListSatisfiesBoot(envScreeningList({ APP_ENV: appEnv }))).toBe(false);
      expect(() => assertScreeningConfigured({ APP_ENV: appEnv })).toThrow(UnscreenedJurisdictionError);
    }
  });

  /**
   * And ships no business block either. If this fails, somebody added
   * `blocked: true` to the matrix — which is allowed, and is a commercial
   * decision — and this test is where they confirm they meant a commercial
   * block and not a sanctions one, which belongs in `screening.ts`.
   */
  it('ships no business block — and if one lands, it is a commercial decision, not a legal one', () => {
    expect(screeningStatus(UNSET_SCREENING_LIST).businessBlockedRegions).toEqual([]);
  });
});
