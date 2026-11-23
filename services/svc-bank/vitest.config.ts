import { defineConfig } from 'vitest/config';
import { TEST_BUDGET } from '../../tooling/vitest/budget.mjs';

export default defineConfig({
  test: {
    ...TEST_BUDGET,
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
      // The custody switch as the TEST journey stack runs it (custodial layer on); a test of the switch off sets its own.
      LEDGER_CUSTODY_LAYER: 'on',
    },
  },
});
