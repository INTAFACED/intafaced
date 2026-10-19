import { defineConfig } from 'vitest/config';

/**
 * Customer journeys against the REAL assembled stack (ledger, identity, matching, trade, NATS, Postgres).
 * Not part of `pnpm test`: it needs the stack up. `pnpm journeys:trade` (repo root) boots it and runs this.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/journeys/**/*.journey.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
