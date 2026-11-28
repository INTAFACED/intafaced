import { vi } from 'vitest';

/**
 * Shared by the env tests: load svc-p2p's own `env.ts` the way the process does (it calls `loadEnv(process.env)` at
 * import), over a minimal boot env plus the overrides one test names. `undefined` removes a key. A forked copy of the
 * schema would stay green if production grew a default; this reads the real one.
 */
const BASE: Record<string, string> = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://p2p:p2p@127.0.0.1:5432/p2p_test',
  DATABASE_POOL_MAX: '10',
  NATS_URL: 'nats://127.0.0.1:4222',
  REDIS_URL: 'redis://127.0.0.1:6379',
  EDGE_PRINCIPAL_SECRET: 'test-only-edge-principal-secret-at-least-32-chars',
  INTERNAL_SERVICE_SECRET: 'test-only-internal-service-secret-at-least-32',
};

/** Every owner value this file's callers read, cleared so a developer's shell cannot answer for the schema. */
const CLEARED = [
  'P2P_FEE_BPS',
  'P2P_ESCROW_DEADLINE_SECONDS',
  'P2P_PAYMENT_DEADLINE_SECONDS',
  'P2P_RELEASE_DEADLINE_SECONDS',
  'P2P_DISPUTE_SLA_SECONDS',
  'P2P_DISPUTE_ESCALATION_RECHECK_SECONDS',
  'P2P_SWEEP_INTERVAL_SECONDS',
  'P2P_INSTRUMENT_RETENTION_DAYS',
  'IDENTITY_URL',
  'JWT_ACCESS_TTL_SECONDS',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
];

export async function loadP2pEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const key of CLEARED) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({ ...BASE, ...overrides })) vi.stubEnv(key, value);
  try {
    return (await import('../env.js')).env;
  } finally {
    vi.unstubAllEnvs();
  }
}
