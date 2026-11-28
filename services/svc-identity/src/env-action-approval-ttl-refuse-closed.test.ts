/**
 * IDENTITY_ACTION_APPROVAL_TTL_SECONDS refuse-closed.
 * Blank / unset is unpublished. Never git-default 900 or 15 minutes.
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
  vi.stubEnv('IDENTITY_ACTION_APPROVAL_TTL_SECONDS', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('IDENTITY_ACTION_APPROVAL_TTL_SECONDS refuse-closed', () => {
  it('env.ts publishes no lifetime of its own (unset, blank or spaces stay unpublished)', async () => {
    for (const value of [undefined, '', '   ']) {
      const parsed = await loadWith({ IDENTITY_ACTION_APPROVAL_TTL_SECONDS: value });
      expect(parsed.IDENTITY_ACTION_APPROVAL_TTL_SECONDS, JSON.stringify(value)).toBeUndefined();
    }
  });

  it('unset is unpublished', async () => {
    const parsed = await loadWith({});
    expect(parsed.IDENTITY_ACTION_APPROVAL_TTL_SECONDS).toBeUndefined();
  });

  it('blank is unpublished', async () => {
    const parsed = await loadWith({ IDENTITY_ACTION_APPROVAL_TTL_SECONDS: '' });
    expect(parsed.IDENTITY_ACTION_APPROVAL_TTL_SECONDS).toBeUndefined();
  });

  it('owner-explicit 120 is allowed', async () => {
    const parsed = await loadWith({ IDENTITY_ACTION_APPROVAL_TTL_SECONDS: '120' });
    expect(parsed.IDENTITY_ACTION_APPROVAL_TTL_SECONDS).toBe(120);
  });

  it('zero refuses boot', async () => {
    await expect(loadWith({ IDENTITY_ACTION_APPROVAL_TTL_SECONDS: '0' })).rejects.toThrow(/IDENTITY_ACTION_APPROVAL_TTL_SECONDS/);
  });
});
