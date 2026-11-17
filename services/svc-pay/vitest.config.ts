import { defineConfig } from 'vitest/config';
import { TEST_BUDGET } from '../../tooling/vitest/budget.mjs';
export default defineConfig({
  test: {
    ...TEST_BUDGET,
    env: {
      APP_ENV: 'test',
      // Domain fixtures use no counsel-provided list. router.mount.test restores
      // strict defaults and proves refusal through the actual signed HTTP mount.
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
