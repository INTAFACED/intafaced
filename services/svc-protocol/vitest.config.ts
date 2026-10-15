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
    fileParallelism: false,
    // Business fixtures isolate the blank screening socket. Mounted-request tests
    // explicitly arm strict policy; production defaults remain unchanged.
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
