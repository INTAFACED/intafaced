/**
 * OAUTH_CODE_TTL_SECONDS and OAUTH_ACCESS_TOKEN_TTL_SECONDS refuse-closed.
 * Blank / unset is unpublished. Never git-default a lifetime.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);
const NAMES = ['OAUTH_CODE_TTL_SECONDS', 'OAUTH_ACCESS_TOKEN_TTL_SECONDS'] as const;

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
  for (const name of NAMES) vi.stubEnv(name, undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  return (await import('../env.js')).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(NAMES)('%s refuse-closed', (name) => {
  it('env.ts does not git-default the lifetime', () => {
    const envTs = readFileSync(join(HERE, '..', 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(new RegExp(`${name}:[\\s\\S]{0,400}\\.default\\(`));
  });

  it('unset and blank are unpublished', async () => {
    expect((await loadWith({}))[name]).toBeUndefined();
    expect((await loadWith({ [name]: '' }))[name]).toBeUndefined();
  });

  it('an owner-explicit value is read, and zero refuses boot', async () => {
    expect((await loadWith({ [name]: '120' }))[name]).toBe(120);
    await expect(loadWith({ [name]: '0' })).rejects.toThrow(new RegExp(name));
  });
});
