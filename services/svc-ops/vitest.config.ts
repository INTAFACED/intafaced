import { defineConfig } from 'vitest/config';

// Business fixtures isolate the blank screening socket. The strict-screening test in
// src/router.mount.test.ts unsets this switch (the production default) and proves a
// signed request refuses denied.screening_unconfigured; production defaults are unchanged.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
