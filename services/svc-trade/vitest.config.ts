import { defineConfig } from 'vitest/config';

// Business fixtures exercise trade behaviour with an explicitly unconfigured
// screening socket (the same stance as svc-bank / svc-agents / svc-token). Tests
// that need strict mode stub it back with vi.stubEnv. Production screening
// defaults remain strict (#4499 made unset refuse).
//
// close-position.ts and matching-close.ts read the validated service env at
// import. These are labelled test-only placeholders, not real secrets; they only
// apply when the variable is not already exported by the caller.
export default defineConfig({
  test: {
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://svc_trade@127.0.0.1:5432/intafaced_trade_test',
      DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? '2',
      EDGE_PRINCIPAL_SECRET: process.env.EDGE_PRINCIPAL_SECRET ?? 'test-only-edge-principal-secret-0123456789',
      INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET ?? 'test-only-internal-service-secret-0123456789',
    },
  },
});
