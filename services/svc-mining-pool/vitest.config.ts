import { defineConfig } from 'vitest/config';
import { TEST_BUDGET } from '../../tooling/vitest/budget.mjs';
export default defineConfig({ test: { ...TEST_BUDGET, globals: true } });
