import { defineConfig } from 'vitest/config';
import { TEST_BUDGET } from '../../tooling/vitest/budget.mjs';

// The shared budget (tooling/vitest/budget.mjs): a TEST seed signs every maker ladder level, a few seconds on a busy runner.
export default defineConfig({ test: { ...TEST_BUDGET } });
