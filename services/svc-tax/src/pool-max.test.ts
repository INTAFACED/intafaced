/**
 * DATABASE_POOL_MAX is the shared postgres schema's number.
 * A database with a blank size refuses. No size is filled in.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAX_DATABASE_POOL_MAX_UNSET } from './codes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);
const URL = 'postgres://svc_tax:svc_tax@127.0.0.1:55432/intafaced_test';

const BASE_ENV = {
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: SECRET,
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', undefined);
  vi.stubEnv('DATABASE_POOL_MAX', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-tax DATABASE_POOL_MAX', () => {
  const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
  const indexTs = readFileSync(join(HERE, 'index.ts'), 'utf8');

  it('reads the shared refuse-if-blank field and does not hardcode a pool', () => {
    expect(envTs).toMatch(/postgresEnvSchema\.shape\.DATABASE_POOL_MAX/);
    expect(envTs).not.toMatch(/DATABASE_POOL_MAX[\s\S]{0,120}\.default\(/);
    expect(indexTs).not.toMatch(/max:\s*4/);
    expect(indexTs).toMatch(/max:\s*poolMax/);
  });

  it('a blank size with a database refuses and does not invent one', async () => {
    await expect(loadWith({ DATABASE_URL: URL, DATABASE_POOL_MAX: '' })).rejects.toMatchObject({
      name: 'EnvError',
      issues: [`DATABASE_POOL_MAX: ${TAX_DATABASE_POOL_MAX_UNSET}`],
    });
    await expect(loadWith({ DATABASE_URL: URL, DATABASE_POOL_MAX: '   ' })).rejects.toMatchObject({
      name: 'EnvError',
      issues: [`DATABASE_POOL_MAX: ${TAX_DATABASE_POOL_MAX_UNSET}`],
    });
    await expect(loadWith({ DATABASE_URL: URL })).rejects.toMatchObject({
      name: 'EnvError',
      issues: [`DATABASE_POOL_MAX: ${TAX_DATABASE_POOL_MAX_UNSET}`],
    });
  });

  it('zero and a non-integer are not a pool', async () => {
    await expect(loadWith({ DATABASE_URL: URL, DATABASE_POOL_MAX: '0' })).rejects.toThrow(/DATABASE_POOL_MAX/);
    await expect(loadWith({ DATABASE_URL: URL, DATABASE_POOL_MAX: '1.5' })).rejects.toThrow(/DATABASE_POOL_MAX/);
  });

  it('uses the owner size, and a missing database does not need one', async () => {
    const sized = await loadWith({ DATABASE_URL: URL, DATABASE_POOL_MAX: '4' });
    expect(sized.DATABASE_POOL_MAX).toBe(4);
    const unwired = await loadWith({ DATABASE_URL: '', DATABASE_POOL_MAX: '' });
    expect(unwired.DATABASE_URL).toBeUndefined();
    expect(unwired.DATABASE_POOL_MAX).toBeUndefined();
  });
});
