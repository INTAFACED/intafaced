/**
 * IDENTITY_ACCOUNT_CLOSE_ENABLED ships off.
 * Unset, blank, false, off, no or 0 is off. true, on, yes or 1 is on. Anything else refuses boot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 's'.repeat(32);
const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: SECRET,
  JWT_ACCESS_SECRET: SECRET,
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('IDENTITY_ACCOUNT_CLOSE_ENABLED', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('IDENTITY_ACCOUNT_CLOSE_ENABLED', () => {
  it('is off when unset', async () => {
    expect((await loadWith()).IDENTITY_ACCOUNT_CLOSE_ENABLED).toBe(false);
  });

  it.each(['', '  ', '0', 'false', 'off', 'no'])('is off for %j', async (raw) => {
    expect((await loadWith({ IDENTITY_ACCOUNT_CLOSE_ENABLED: raw })).IDENTITY_ACCOUNT_CLOSE_ENABLED).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes'])('is on for %j', async (raw) => {
    expect((await loadWith({ IDENTITY_ACCOUNT_CLOSE_ENABLED: raw })).IDENTITY_ACCOUNT_CLOSE_ENABLED).toBe(true);
  });

  it('refuses an unknown string', async () => {
    await expect(loadWith({ IDENTITY_ACCOUNT_CLOSE_ENABLED: 'maybe' })).rejects.toThrow(/IDENTITY_ACCOUNT_CLOSE_ENABLED/);
  });
});
