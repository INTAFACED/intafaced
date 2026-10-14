/**
 * Unit card: founder invite env vars refuse closed.
 *
 * Promise: IDENTITY_FOUNDER_INVITE_HASHES / _EXPIRES_AT unset or blank parse to
 * undefined (enrolment closed). Valid values pass through. A malformed value
 * fails boot. env.ts invents no default. Loads the production env.ts, as boot does.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);
const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: SECRET,
  JWT_ACCESS_SECRET: SECRET,
};
const H = `${'a'.repeat(64)},${'b'.repeat(64)}`;

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('IDENTITY_FOUNDER_INVITE_HASHES', undefined);
  vi.stubEnv('IDENTITY_FOUNDER_INVITE_EXPIRES_AT', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  return (await import('./env.js')).env;
}

afterEach(() => vi.unstubAllEnvs());

describe('founder invite env vars', () => {
  it('env.ts carries no default for either variable', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/IDENTITY_FOUNDER_INVITE_(HASHES|EXPIRES_AT):[^\n]*(default|'[0-9a-f]{8})/);
  });

  it('unset is closed (undefined)', async () => {
    const env = await loadWith();
    expect(env.IDENTITY_FOUNDER_INVITE_HASHES).toBeUndefined();
    expect(env.IDENTITY_FOUNDER_INVITE_EXPIRES_AT).toBeUndefined();
  });

  it('blank (compose ${VAR:-}) is closed (undefined)', async () => {
    const env = await loadWith({ IDENTITY_FOUNDER_INVITE_HASHES: '', IDENTITY_FOUNDER_INVITE_EXPIRES_AT: '  ' });
    expect(env.IDENTITY_FOUNDER_INVITE_HASHES).toBeUndefined();
    expect(env.IDENTITY_FOUNDER_INVITE_EXPIRES_AT).toBeUndefined();
  });

  it('valid values pass through', async () => {
    const env = await loadWith({ IDENTITY_FOUNDER_INVITE_HASHES: H, IDENTITY_FOUNDER_INVITE_EXPIRES_AT: '2026-10-17T00:00:00Z' });
    expect(env.IDENTITY_FOUNDER_INVITE_HASHES).toBe(H);
    expect(env.IDENTITY_FOUNDER_INVITE_EXPIRES_AT).toBe('2026-10-17T00:00:00Z');
  });

  it('a malformed hash list or expiry fails boot', async () => {
    await expect(loadWith({ IDENTITY_FOUNDER_INVITE_HASHES: 'a'.repeat(64) })).rejects.toThrow();
    await expect(loadWith({ IDENTITY_FOUNDER_INVITE_HASHES: H.toUpperCase() })).rejects.toThrow();
    await expect(loadWith({ IDENTITY_FOUNDER_INVITE_EXPIRES_AT: 'soon' })).rejects.toThrow();
  });
});
