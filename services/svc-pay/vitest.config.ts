import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    env: {
      // Explicit test env. An unset APP_ENV is not dev: PAY_MERCHANT_CONTROLS
      // unset would refuse to boot, and every guard built from process.env
      // would throw. Suites that want the local-test stand-in say `test`.
      APP_ENV: 'test',
      // Domain fixtures use no counsel-provided list. router.mount.test restores
      // strict defaults and proves refusal through the actual signed HTTP mount.
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
