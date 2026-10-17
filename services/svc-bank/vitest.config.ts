import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
