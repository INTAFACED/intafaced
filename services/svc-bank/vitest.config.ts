import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
      // The custody switch as the TEST journey stack runs it (custodial layer on); a test of the switch off sets its own.
      LEDGER_CUSTODY_LAYER: 'on',
    },
  },
});
