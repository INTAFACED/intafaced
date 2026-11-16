import { defineConfig } from 'vitest/config';
import { TEST_BUDGET } from '../../tooling/vitest/budget.mjs';

// The shared budget (tooling/vitest/budget.mjs); no other setting.
export default defineConfig({ test: { ...TEST_BUDGET } });
