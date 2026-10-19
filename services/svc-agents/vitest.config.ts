import { defineConfig } from 'vitest/config';

// Business fixtures exercise agent decisions with an explicitly unconfigured
// screening socket. HTTP controls arm strict policy and prove refusal before
// downstream effects. Production screening defaults remain strict.
export default defineConfig({
  test: {
    env: { APP_ENV: 'test', INTAFACED_SCREENING_FAIL_CLOSED: 'off' },
  },
});
