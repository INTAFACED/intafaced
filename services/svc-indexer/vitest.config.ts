import { defineConfig } from 'vitest/config';

// Business fixtures isolate the blank screening socket. Mounted-request tests
// explicitly arm strict policy; production defaults remain unchanged.
export default defineConfig({
  test: {
    env: {
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
