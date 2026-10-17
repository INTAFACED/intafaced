import { isExplicitDevOrTest } from './app-env.js';
import { SCREENING_FAIL_CLOSED_ENV, screeningFailClosedIsExplicitlyOff } from './jurisdiction.js';
import { envScreeningList, screeningLooksLikeFixture, type ScreeningList } from './screening.js';

/**
 * Boot guard: local-test stand-ins refuse to run outside an explicit dev/test
 * process. See app-env.ts for why the raw `APP_ENV` is read (unset = NOT dev).
 *
 * Checks, in a process that is not explicitly dev/test:
 *   1. `INTAFACED_SCREENING_FAIL_CLOSED` must not be an explicit off value.
 *   2. The env screening list must not be a stand-in: no `ZZ`, no fixture
 *      marker in its source or reasons, and not made up only of user-assigned
 *      codes. `XK` (Kosovo) is a real, counsel-usable code and never counts as
 *      user-assigned.
 *   3. `LOCAL_TEST_KMS` must not be set. A local-test instrument key is a
 *      stand-in, and every service that calls this guard refuses it.
 *
 * It does NOT say the list is complete or counsel-approved; that stays with
 * `assertScreeningConfigured` and the owner. It only refuses the stand-ins.
 */

/** Stable code carried on `LocalTestFixtureError` for logs and tests. */
export const LOCAL_TEST_FIXTURE_REFUSE_CODE = 'config.local_test_fixture_outside_dev_test' as const;

/**
 * ISO 3166-1 user-assigned alpha-2 codes: AA, QM-QZ, XA-XZ, ZZ.
 * `XK` (Kosovo) sits in the XA-XZ range but is in real use, so it is excluded.
 */
export function isUserAssignedRegionCode(code: string): boolean {
  const upper = code.trim().toUpperCase();
  if (upper === 'XK') return false;
  return upper === 'AA' || upper === 'ZZ' || /^Q[M-Z]$/.test(upper) || /^X[A-Z]$/.test(upper);
}

/** Why a screening list looks like a local-test stand-in. Empty means it does not. */
export function screeningListStandInIssues(list: ScreeningList): string[] {
  const issues: string[] = [];
  const codes = list.regions.map((r) => r.region);
  if (codes.some((c) => c.toUpperCase() === 'ZZ')) {
    issues.push('the screening list contains the user-assigned code ZZ (a local-test stand-in)');
  }
  if (screeningLooksLikeFixture(list.source, ...list.regions.map((r) => r.reason))) {
    issues.push('the screening list is marked as a placeholder/test fixture in its source or reasons');
  }
  if (codes.length > 0 && codes.every(isUserAssignedRegionCode)) {
    issues.push(`every code in the screening list is user-assigned (${codes.join(', ')}), so none is a real jurisdiction`);
  }
  return issues;
}

export class LocalTestFixtureError extends Error {
  readonly code = LOCAL_TEST_FIXTURE_REFUSE_CODE;
  constructor(
    readonly appEnv: string | null,
    readonly issues: readonly string[],
  ) {
    super(
      `LOCAL-TEST STAND-INS ARE NOT ALLOWED HERE (APP_ENV=${appEnv === null || appEnv === '' ? '<unset>' : appEnv}, ${LOCAL_TEST_FIXTURE_REFUSE_CODE}). Refusing to start.\n` +
        `Stand-ins are only allowed when APP_ENV is exactly "dev" or "test". An unset APP_ENV counts as NOT dev.\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'LocalTestFixtureError';
  }
}

/** Every stand-in found in `env`. Always empty for an explicit dev/test process. */
export function localTestFixtureIssues(env: Record<string, string | undefined> = process.env): string[] {
  if (isExplicitDevOrTest(env.APP_ENV)) return [];
  const issues: string[] = [];
  if (screeningFailClosedIsExplicitlyOff(env)) {
    issues.push(`${SCREENING_FAIL_CLOSED_ENV} is set to an explicit off value (screening would let unscreened regions through)`);
  }
  issues.push(...screeningListStandInIssues(envScreeningList(env)));
  const localTestKms = env.LOCAL_TEST_KMS;
  if (typeof localTestKms === 'string' && localTestKms.trim() !== '') {
    issues.push('LOCAL_TEST_KMS is set');
  }
  return issues;
}

/** Throws `LocalTestFixtureError` if a local-test stand-in is configured outside explicit dev/test. */
export function assertNoLocalTestFixtures(env: Record<string, string | undefined> = process.env): void {
  const issues = localTestFixtureIssues(env);
  if (issues.length > 0) throw new LocalTestFixtureError(env.APP_ENV ?? null, issues);
}
