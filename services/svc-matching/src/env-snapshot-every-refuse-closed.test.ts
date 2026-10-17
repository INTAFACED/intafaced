/**
 * Unit card — svc-matching MATCHING_SNAPSHOT_EVERY unset refuse (no invented 500)
 *
 * 1. Promise: unset / blank MATCHING_SNAPSHOT_EVERY refuses boot (never invent
 *    500). Owner-explicit 500 is a published cadence. Owner-explicit 0 disables.
 * 2. Break: env.ts `.default(500)` / compose `:-500` makes a blank host env
 *    look published as a snapshot interval nobody chose. Empty string must not
 *    coerce to 0 (0 is a real disable).
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset,
 *    blank, and whitespace; explicit 500 and 0 parse; source has no `.default(500)`.
 * 4. Class N
 * 5. Paths: env.ts via loadEnv at import (same as boot)
 * 6. RED: git-default 500 returns, or unset/blank parses as 500 or 0
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);

/** Minimum boot env so assertions are about snapshot cadence. */
const BASE_ENV = {
  INTERNAL_SERVICE_SECRET: SECRET,
  MATCHING_SNAPSHOT_EVERY: '500',
  MATCHING_OPERATOR_IDS: 'op-a,op-b',
};

/**
 * Load production env.ts the way the process does.
 *
 * `vi.resetModules` + explicit clears are load-bearing: env.ts calls
 * `loadEnv(process.env)` at import. A forked Zod slice would stay green if
 * production `.default(500)` returned.
 */
async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('MATCHING_SNAPSHOT_EVERY', undefined);
  vi.stubEnv('INTERNAL_SERVICE_SECRET', SECRET);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-matching MATCHING_SNAPSHOT_EVERY refuse-closed', () => {
  it('env.ts keeps the refuse-closed shape production loadEnv parses', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).toMatch(
      /MATCHING_SNAPSHOT_EVERY:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.coerce\.number\(\)\.int\(\)\.min\(0\),\s*\)/,
    );
    expect(envTs).not.toMatch(/MATCHING_SNAPSHOT_EVERY:[\s\S]{0,400}\.default\(500\)/);
  });

  it('unset MATCHING_SNAPSHOT_EVERY refuses (no invent 500)', async () => {
    await expect(loadWith({ MATCHING_SNAPSHOT_EVERY: undefined })).rejects.toThrow(/MATCHING_SNAPSHOT_EVERY/);
  });

  it('blank MATCHING_SNAPSHOT_EVERY refuses (empty is not 0)', async () => {
    await expect(loadWith({ MATCHING_SNAPSHOT_EVERY: '' })).rejects.toThrow(/MATCHING_SNAPSHOT_EVERY/);
  });

  it('whitespace MATCHING_SNAPSHOT_EVERY refuses', async () => {
    await expect(loadWith({ MATCHING_SNAPSHOT_EVERY: '   ' })).rejects.toThrow(/MATCHING_SNAPSHOT_EVERY/);
  });

  it('explicit 500 is owner-published (not invented)', async () => {
    const parsed = await loadWith({ MATCHING_SNAPSHOT_EVERY: '500' });
    expect(parsed.MATCHING_SNAPSHOT_EVERY).toBe(500);
  });

  it('explicit 0 disables snapshotting (owner-published, not blank)', async () => {
    const parsed = await loadWith({ MATCHING_SNAPSHOT_EVERY: '0' });
    expect(parsed.MATCHING_SNAPSHOT_EVERY).toBe(0);
  });
});
