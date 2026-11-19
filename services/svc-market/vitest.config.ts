import { defineConfig } from 'vitest/config';
import { TEST_BUDGET } from '../../tooling/vitest/budget.mjs';

export default defineConfig({
  test: {
    ...TEST_BUDGET,
    // Existing service fixtures exercise commerce/authority without a live
    // screening list. router.mount.test.ts explicitly restores default blank
    // screening and proves a signed request refuses before the service runs.
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
