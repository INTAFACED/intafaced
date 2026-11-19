import { defineConfig } from 'vitest/config';
import { TEST_BUDGET } from '../../tooling/vitest/budget.mjs';

// Unit/API fixtures exercise their own business gates. Strict-screening behavior
// is covered explicitly by the signed-request test in export-blank-map.public.test.ts.
export default defineConfig({
  test: {
    ...TEST_BUDGET,
    globalSetup: ['./vitest.refusals.ts'],
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
      // A refusal a handler sends that its record does not list fails the test (`@intafaced/contracts/procedure-mount`).
      PROCEDURE_REFUSALS_STRICT: '1',
    },
  },
});
