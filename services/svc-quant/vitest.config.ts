import { defineConfig } from 'vitest/config';

// Unit and business fixtures opt out of the empty sanctions-list refusal.
// router.mount.test.ts separately verifies the real signed route stays strict.
export default defineConfig({
  test: {
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
