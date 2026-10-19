import { defineConfig } from 'vitest/config';

// Business-door fixtures opt out of the blank screening socket. Mounted request
// controls explicitly arm strict policy; production defaults remain unchanged.
export default defineConfig({
  test: {
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
