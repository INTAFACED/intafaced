import { defineConfig } from 'vitest/config';

// A TEST seed signs every TEST maker's ladder level (six laddered markets since J-derivatives-03's ETH-PERP), which
// takes a few seconds on a busy runner: past vitest's 5 s default, a test that seeds timed out before it asserted.
export default defineConfig({ test: { testTimeout: 30_000 } });
