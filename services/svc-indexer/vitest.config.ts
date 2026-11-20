import { defineConfig } from 'vitest/config';
import { TEST_BUDGET } from '../../tooling/vitest/budget.mjs';

// Business fixtures isolate the blank screening socket. Mounted-request tests
// explicitly arm strict policy; production defaults remain unchanged.
export default defineConfig({
  test: {
    ...TEST_BUDGET,
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
