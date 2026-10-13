import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
