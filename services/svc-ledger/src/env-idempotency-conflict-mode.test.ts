/**
 * Unit card — svc-ledger LEDGER_IDEMPOTENCY_CONFLICT_MODE in enforced environments
 *
 * 1. Promise: a staging/production-posture process answers a reused key with a different body by refusing
 *    (409 ledger.idempotency_conflict), whatever the setting says. Dev and test keep the `detect` default.
 * 2. Break: the schema default `detect` reaches the ledger service unchanged on a real server, so a
 *    different-body replay is answered with the original and nobody is told.
 * 3. Done bar: production env.ts (loadEnv at import) resolves `refuse` for APP_ENV=prod/staging (unset and
 *    explicit detect), and `detect` for dev/test.
 * 6. RED: enforced env resolves to `detect`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 's'.repeat(32);
const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  INTERNAL_SERVICE_SECRET: SECRET,
  INTERNAL_SERVICE_BODY_BIND: 'require',
  JWT_ACCESS_SECRET: SECRET,
  RECONCILE_CRON_MINUTES: '60',
};

async function resolveWith(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('APP_ENV', undefined);
  vi.stubEnv('LEDGER_IDEMPOTENCY_CONFLICT_MODE', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  const module = await import('./env.js');
  return module.idempotencyConflictMode;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-ledger idempotency conflict mode by environment', () => {
  it.each(['prod', 'staging'])('APP_ENV=%s with the mode unset resolves to refuse', async (appEnv) => {
    expect(await resolveWith({ APP_ENV: appEnv })).toBe('refuse');
  });

  it('APP_ENV=prod with an explicit detect still resolves to refuse', async () => {
    expect(await resolveWith({ APP_ENV: 'prod', LEDGER_IDEMPOTENCY_CONFLICT_MODE: 'detect' })).toBe('refuse');
  });

  it('NODE_ENV=production without APP_ENV is enforced too', async () => {
    expect(await resolveWith({ NODE_ENV: 'production' })).toBe('refuse');
  });

  it.each(['dev', 'test'])('APP_ENV=%s keeps the detect default', async (appEnv) => {
    expect(await resolveWith({ APP_ENV: appEnv })).toBe('detect');
  });

  it('APP_ENV=dev honours an explicit refuse', async () => {
    expect(await resolveWith({ APP_ENV: 'dev', LEDGER_IDEMPOTENCY_CONFLICT_MODE: 'refuse' })).toBe('refuse');
  });
});
