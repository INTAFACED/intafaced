import { vi } from 'vitest';

/**
 * Shared by the env tests: load svc-edge's own `env.ts` the way the process does (it calls `loadEnv(process.env)` at
 * import), over the minimum boot env plus the overrides one test names. `undefined` removes a key. A forked copy of
 * the schema would stay green if production grew a default; this reads the real one.
 */
const SECRET = 's'.repeat(32);

const EDGE_BOOT_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_ACCESS_SECRET: SECRET,
  EDGE_PRINCIPAL_SECRET: SECRET,
  EDGE_RATE_LIMIT_MAX: '300',
  EDGE_RATE_LIMIT_WINDOW_MS: '60000',
  EDGE_BODY_LIMIT_BYTES: '1048576',
};

/** Every value the env tests read, cleared so a developer's shell cannot answer for the schema. */
const CLEARED = [
  'EDGE_RATE_LIMIT_ENABLED',
  'EDGE_SANDBOX_HOSTS',
  'LEDGER_URL',
  'MATCHING_URL',
  'IDENTITY_OWNERSHIP_SECRET',
  'JWT_ACCESS_TTL_SECONDS',
  'EDGE_KILL_STATE_PATH',
  'DATABASE_URL',
  'NATS_URL',
  'INTERNAL_SERVICE_SECRET',
];

export async function loadEdgeEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const key of CLEARED) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({ ...EDGE_BOOT_ENV, ...overrides })) vi.stubEnv(key, value);
  try {
    return (await import('../env.js')).env;
  } finally {
    vi.unstubAllEnvs();
  }
}
