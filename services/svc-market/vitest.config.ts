import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Existing service fixtures exercise commerce/authority without a live
    // screening list. router.mount.test.ts explicitly restores default blank
    // screening and proves a signed request refuses before the service runs.
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
