import { isExplicitDevOrTest } from '@intafaced/config';
import type { ScreeningGuardDeps } from './guard.js';

/**
 * The screener a custodial send is asked about (W9). No supplier is connected in this build, so a blank setting installs
 * none and every send is refused `pay.guard_screening_unavailable` until the owner names one.
 *
 * `local-test` exists so a journey on the test stack can walk a send end to end (J-wallet-07 #3-#5): it answers `clear`
 * for every party, its cases are recorded with the provider `local-test`, and it is treated as a named list only for
 * itself. It screens nothing real, and it is refused unless APP_ENV is exactly `dev` or `test`.
 */
export const SCREENING_SCREENER_ENV = 'PAY_SCREENING_SCREENER';
export const LOCAL_TEST_SCREENER = 'local-test';

/** Blank installs nothing. A named screener this build does not have, or the test one outside dev and test, throws. */
export function openScreeningScreener(input: {
  appEnv: string | undefined;
  setting: string | undefined;
}): Pick<ScreeningGuardDeps, 'screener' | 'listPosture' | 'providerLabel'> | null {
  const setting = input.setting?.trim() ?? '';
  if (setting === '') return null;
  if (setting !== LOCAL_TEST_SCREENER) throw new Error(`pay.screening_screener_refused: ${SCREENING_SCREENER_ENV} is not available`);
  if (!isExplicitDevOrTest(input.appEnv)) {
    throw new Error(`pay.screening_screener_refused: ${LOCAL_TEST_SCREENER} is allowed only when APP_ENV is exactly dev or test`);
  }
  return {
    screener: async () => ({ category: 'clear', factors: [{ code: 'local_test_clear' }] }),
    listPosture: 'named',
    providerLabel: LOCAL_TEST_SCREENER,
  };
}
