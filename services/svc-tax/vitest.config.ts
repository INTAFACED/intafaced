import { defineConfig } from 'vitest/config';

// Unit/API fixtures exercise their own business gates. Strict-screening behavior
// is covered explicitly by the signed-request test in export-blank-map.public.test.ts.
export default defineConfig({
  test: {
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
