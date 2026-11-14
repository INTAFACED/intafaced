import { defineConfig } from 'vitest/config';

/**
 * ONE ANVIL, ONE FILE AT A TIME.
 *
 * On-chain suites share a single anvil. `evm_increaseTime` is process-global, so
 * a parallel LegacyVault / vesting / escrow file can elapse another suite's
 * inactivity window and surface as InSuccession / Unhealthy / empty debt in a
 * file the author did not touch.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    // Business fixtures isolate the blank screening socket. The strict-screening test in
    // src/router.mount.test.ts unsets this switch (the production default) and proves a
    // signed request refuses denied.screening_unconfigured; production defaults are unchanged.
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
