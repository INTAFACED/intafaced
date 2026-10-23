/**
 * MC-blueprint-01. Share cap and opener page size stay unpublished until set.
 * 0 is a deliberate value. Neither key is git-defaulted.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 'an-edge-principal-secret-long-enough-for-the-schema',
  BLUEPRINT_ENGINE_MODE: 'mock',
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('BLUEPRINT_SHARES_PER_OWNER', undefined);
  vi.stubEnv('BLUEPRINT_OPENS_LIST_LIMIT', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('BLUEPRINT share limits refuse-closed (MC-blueprint-01)', () => {
  it('env.ts does not git-default a share count or a page size', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/BLUEPRINT_SHARES_PER_OWNER:[\s\S]{0,400}\.default\(/);
    expect(envTs).not.toMatch(/BLUEPRINT_OPENS_LIST_LIMIT:[\s\S]{0,400}\.default\(/);
  });

  it('unset and blank stay unpublished, and 0 is kept', async () => {
    expect((await loadWith({})).BLUEPRINT_SHARES_PER_OWNER).toBeUndefined();
    expect((await loadWith({})).BLUEPRINT_OPENS_LIST_LIMIT).toBeUndefined();
    expect(
      (await loadWith({ BLUEPRINT_SHARES_PER_OWNER: '', BLUEPRINT_OPENS_LIST_LIMIT: '   ' })).BLUEPRINT_SHARES_PER_OWNER,
    ).toBeUndefined();
    expect((await loadWith({ BLUEPRINT_SHARES_PER_OWNER: '0', BLUEPRINT_OPENS_LIST_LIMIT: '0' })).BLUEPRINT_SHARES_PER_OWNER).toBe(0);
    expect((await loadWith({ BLUEPRINT_SHARES_PER_OWNER: '2', BLUEPRINT_OPENS_LIST_LIMIT: '20' })).BLUEPRINT_OPENS_LIST_LIMIT).toBe(20);
    await expect(loadWith({ BLUEPRINT_SHARES_PER_OWNER: 'nope' })).rejects.toThrow(/BLUEPRINT_SHARES_PER_OWNER/);
  });
});
