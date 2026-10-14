import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // Domain fixtures use no counsel-provided list. router.mount.test restores
      // strict defaults and proves refusal through the actual signed HTTP mount.
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
