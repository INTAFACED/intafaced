import { defineConfig } from 'vitest/config';
import { TEST_BUDGET } from '../../tooling/vitest/budget.mjs';

// Business fixtures isolate the blank screening socket. The strict-screening test in
// src/router.mount.test.ts unsets this switch (the production default) and proves a
// signed request refuses denied.screening_unconfigured; production defaults are unchanged.
export default defineConfig({
  test: {
    ...TEST_BUDGET,
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
