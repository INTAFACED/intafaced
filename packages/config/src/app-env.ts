/**
 * LOCAL-TEST STAND-INS MUST NOT WORK ON A REAL SERVER — the leaf helpers.
 *
 * The local test stack uses stand-ins that are deliberately not real: a
 * screening list with the user-assigned code `ZZ`, market-lifecycle
 * publications whose ids start with `local-test:`, and
 * `INTAFACED_SCREENING_FAIL_CLOSED=off`. Each is harmless on a laptop and a
 * serious problem on a server real users can reach. These helpers answer the
 * one question every guard asks: "is this process EXPLICITLY a dev or test one?"
 *
 * THE ANSWER READS THE RAW VALUE, NOT THE SCHEMA'S DEFAULT. `baseEnvSchema`
 * (env.ts) defaults an unset `APP_ENV` to `dev` so a laptop boots without
 * ceremony. A guard that took that default would let a production host that
 * simply forgot `APP_ENV` run on stand-ins. So here: unset, empty, whitespace,
 * a typo, or a different case are all "not dev" — the safe direction.
 *
 * Leaf file: imports nothing from this package, so jurisdiction.ts and
 * local-test-guard.ts can both use it without an import cycle.
 */

/** The only `APP_ENV` values under which a local-test stand-in may run. */
export const LOCAL_TEST_ALLOWED_APP_ENVS = ['dev', 'test'] as const;

/** Ids on local-test market-lifecycle publications start with this. */
export const LOCAL_TEST_MARKER_PREFIX = 'local-test:' as const;

/**
 * True only when `appEnv` is exactly `dev` or `test`. Unset, empty, blank,
 * `staging`, `prod`, `production`, `DEV` and anything else are all false.
 */
export function isExplicitDevOrTest(appEnv: string | null | undefined): boolean {
  return appEnv === 'dev' || appEnv === 'test';
}

/** `isExplicitDevOrTest` over the RAW env map (defaults to `process.env`). */
export function isExplicitDevOrTestEnv(env: Record<string, string | undefined> = process.env): boolean {
  return isExplicitDevOrTest(env.APP_ENV);
}

/** True when `value` is a string carrying the `local-test:` marker (case-insensitive, trimmed). */
export function hasLocalTestMarker(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith(LOCAL_TEST_MARKER_PREFIX);
}
