import { defineConfig } from 'vitest/config';

/**
 * svc-token Postgres suites share `token.buyback_runs` (GiST exclusion) and
 * truncate in beforeEach. Parallel files race and invent flake as overlap /
 * empty-row failures — serialize file runs for this package only.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    // Unit/API fixtures exercise service behavior without owner screening
    // configuration. Strict screening remains covered explicitly below.
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
