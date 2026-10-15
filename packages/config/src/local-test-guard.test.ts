import { describe, expect, it } from 'vitest';
import {
  LocalTestFixtureError,
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_FAIL_CLOSED_ENV,
  assertNoLocalTestFixtures,
  hasLocalTestMarker,
  isExplicitDevOrTest,
  isUserAssignedRegionCode,
  localTestFixtureIssues,
  screeningFailClosedFromEnv,
  screeningListStandInIssues,
  parseScreeningList,
} from './index.js';

type Env = Record<string, string | undefined>;

/** [label, APP_ENV value, allowed to run stand-ins?] */
const ENV_MATRIX: ReadonlyArray<readonly [string, string | undefined, boolean]> = [
  ['dev', 'dev', true],
  ['test', 'test', true],
  ['staging', 'staging', false],
  ['prod', 'prod', false],
  ['unset', undefined, false],
  ['empty', '', false],
];

const withApp = (appEnv: string | undefined, rest: Env): Env => (appEnv === undefined ? { ...rest } : { ...rest, APP_ENV: appEnv });

// Counsel-style list: real codes, no fixture marker. Illustrative only, not a sanctions list.
const REAL_LIST: Env = { [SANCTIONS_REGIONS_ENV]: 'KP:programme ref,IR:programme ref', [SANCTIONS_SOURCE_ENV]: 'counsel-memo-2026-08-01' };

describe('isExplicitDevOrTest', () => {
  it.each(ENV_MATRIX)('%s -> %s', (_label, appEnv, allowed) => {
    expect(isExplicitDevOrTest(appEnv)).toBe(allowed);
  });
  it('treats near-misses as NOT dev', () => {
    for (const v of ['DEV', ' dev', 'dev ', 'development', 'production', 'local', null]) {
      expect(isExplicitDevOrTest(v as string | null)).toBe(false);
    }
  });
});

describe('hasLocalTestMarker', () => {
  it('matches the local-test: prefix only', () => {
    expect(hasLocalTestMarker('local-test:actor-1')).toBe(true);
    expect(hasLocalTestMarker('  LOCAL-TEST:grant')).toBe(true);
    expect(hasLocalTestMarker('local-test')).toBe(false);
    expect(hasLocalTestMarker('actor:local-test:1')).toBe(false);
    expect(hasLocalTestMarker(undefined)).toBe(false);
    expect(hasLocalTestMarker(5)).toBe(false);
  });
});

describe('isUserAssignedRegionCode', () => {
  it('flags AA, QM-QZ, XA-XZ and ZZ but never XK', () => {
    for (const c of ['AA', 'zz', 'QM', 'QZ', 'XA', 'XX', 'XZ']) expect(isUserAssignedRegionCode(c)).toBe(true);
    for (const c of ['XK', 'xk', 'QL', 'US', 'KP', 'ZA', 'AB']) expect(isUserAssignedRegionCode(c)).toBe(false);
  });
});

describe('screeningListStandInIssues', () => {
  it('flags ZZ, fixture markers, and all-user-assigned lists', () => {
    expect(screeningListStandInIssues(parseScreeningList('ZZ:x,KP:y', 'counsel-memo')).join()).toMatch(/ZZ/);
    expect(screeningListStandInIssues(parseScreeningList('KP:placeholder', 'counsel-memo')).join()).toMatch(/placeholder\/test fixture/);
    expect(screeningListStandInIssues(parseScreeningList('KP:y', 'test-fixture')).join()).toMatch(/placeholder\/test fixture/);
    expect(screeningListStandInIssues(parseScreeningList('AA:x,QM:y', 'counsel-memo')).join()).toMatch(/user-assigned/);
  });
  it('accepts XK-only and mixed real lists, and a reviewed-empty counsel answer', () => {
    expect(screeningListStandInIssues(parseScreeningList('XK:programme ref', 'counsel-memo'))).toEqual([]);
    expect(screeningListStandInIssues(parseScreeningList('XK:r,AA:r', 'counsel-memo'))).toEqual([]);
    expect(screeningListStandInIssues(parseScreeningList('KP:r,AA:r', 'counsel-memo'))).toEqual([]);
    expect(screeningListStandInIssues(parseScreeningList('none', 'counsel-memo'))).toEqual([]);
  });
  it('flags a fixture-sourced reviewed-empty answer', () => {
    expect(screeningListStandInIssues(parseScreeningList('none', 'test-fixture')).length).toBeGreaterThan(0);
  });
});

describe.each(ENV_MATRIX)('assertNoLocalTestFixtures under APP_ENV=%s', (_label, appEnv, allowed) => {
  const refuses = (rest: Env) => () => assertNoLocalTestFixtures(withApp(appEnv, rest));

  it('screening list containing ZZ', () => {
    const env: Env = { [SANCTIONS_REGIONS_ENV]: 'ZZ:local test stand-in', [SANCTIONS_SOURCE_ENV]: 'counsel-memo' };
    if (allowed) expect(refuses(env)).not.toThrow();
    else expect(refuses(env)).toThrow(LocalTestFixtureError);
  });

  it('fixture-marked screening list', () => {
    const env: Env = { [SANCTIONS_REGIONS_ENV]: 'KP:reason', [SANCTIONS_SOURCE_ENV]: 'test-fixture-list' };
    if (allowed) expect(refuses(env)).not.toThrow();
    else expect(refuses(env)).toThrow(LocalTestFixtureError);
  });

  it.each(['off', 'OFF', '0', 'false', 'no'])('INTAFACED_SCREENING_FAIL_CLOSED=%s', (value) => {
    const env: Env = { ...REAL_LIST, [SCREENING_FAIL_CLOSED_ENV]: value };
    if (allowed) expect(refuses(env)).not.toThrow();
    else expect(refuses(env)).toThrow(/INTAFACED_SCREENING_FAIL_CLOSED/);
  });

  it('a real list with fail-closed on or unset is accepted', () => {
    expect(refuses(REAL_LIST)).not.toThrow();
    expect(refuses({ ...REAL_LIST, [SCREENING_FAIL_CLOSED_ENV]: 'on' })).not.toThrow();
  });

  it('XK-only list is accepted everywhere', () => {
    expect(refuses({ [SANCTIONS_REGIONS_ENV]: 'XK:programme ref', [SANCTIONS_SOURCE_ENV]: 'counsel-memo-2026-08-01' })).not.toThrow();
  });

  it("an unset screening list is not this guard's job (assertScreeningConfigured owns it)", () => {
    expect(refuses({})).not.toThrow();
  });
});

describe('error shape', () => {
  it('names the env, the code, and says unset counts as not dev', () => {
    try {
      assertNoLocalTestFixtures({ [SCREENING_FAIL_CLOSED_ENV]: 'off' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LocalTestFixtureError);
      const err = e as LocalTestFixtureError;
      expect(err.code).toBe('config.local_test_fixture_outside_dev_test');
      expect(err.message).toMatch(/<unset>/);
      expect(err.message).toMatch(/unset APP_ENV counts as NOT dev/);
      expect(err.issues).toHaveLength(1);
    }
  });
  it('reports every issue at once', () => {
    const issues = localTestFixtureIssues({
      APP_ENV: 'prod',
      [SCREENING_FAIL_CLOSED_ENV]: 'off',
      [SANCTIONS_REGIONS_ENV]: 'ZZ:x',
      [SANCTIONS_SOURCE_ENV]: 'test-fixture',
    });
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('screeningFailClosedFromEnv runtime backstop', () => {
  it('ignores off when APP_ENV names a non-dev/test environment', () => {
    for (const appEnv of ['staging', 'prod', 'production', 'DEV']) {
      expect(screeningFailClosedFromEnv({ APP_ENV: appEnv, [SCREENING_FAIL_CLOSED_ENV]: 'off' })).toBe(true);
    }
  });
  it('honours off only for explicit dev/test environments', () => {
    expect(screeningFailClosedFromEnv({ APP_ENV: 'dev', [SCREENING_FAIL_CLOSED_ENV]: 'off' })).toBe(false);
    expect(screeningFailClosedFromEnv({ APP_ENV: 'test', [SCREENING_FAIL_CLOSED_ENV]: '0' })).toBe(false);
    expect(screeningFailClosedFromEnv({ [SCREENING_FAIL_CLOSED_ENV]: 'off' })).toBe(true);
    expect(screeningFailClosedFromEnv({ APP_ENV: '', [SCREENING_FAIL_CLOSED_ENV]: 'off' })).toBe(true);
  });
  it('unset or unrecognised stays fail-closed everywhere', () => {
    expect(screeningFailClosedFromEnv({ APP_ENV: 'prod' })).toBe(true);
    expect(screeningFailClosedFromEnv({ APP_ENV: 'dev', [SCREENING_FAIL_CLOSED_ENV]: 'maybe' })).toBe(true);
  });
});
