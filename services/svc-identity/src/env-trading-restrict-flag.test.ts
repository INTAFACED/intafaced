/**
 * IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL ships off.
 * Unset or blank is off. true/on/1 is on. Any other string refuses boot.
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
  vi.stubEnv('IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL', () => {
  it('is off when unset or blank', async () => {
    expect((await loadWith()).IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL).toBeUndefined();
    expect(
      (await loadWith({ IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL: '  ' })).IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL,
    ).toBeUndefined();
    expect((await loadWith({ IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL: 'false' })).IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL).toBe(
      false,
    );
    expect((await loadWith({ IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL: 'off' })).IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL).toBe(
      false,
    );
  });

  it('is on only for an explicit true, and refuses an unknown string', async () => {
    expect((await loadWith({ IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL: 'true' })).IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL).toBe(
      true,
    );
    expect((await loadWith({ IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL: '1' })).IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL).toBe(true);
    await expect(loadWith({ IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL: 'yes' })).rejects.toThrow(
      /IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL/,
    );
  });
});
