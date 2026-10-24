import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
